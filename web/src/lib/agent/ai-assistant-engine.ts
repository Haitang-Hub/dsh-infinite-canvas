import type { NavigateFunction } from "react-router-dom";

import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { ASSISTANT_MAX_TOOL_ROUNDS, type AssistantMessage } from "@/stores/use-ai-assistant-store";
import type { AiTextMessage } from "@/services/api/image";

/**
 * AI 助手的对话与画布工具引擎：
 * 模型在回复中以 ```tool 代码块声明调用，前端解析后在当前页面内直接执行，
 * 结果回填对话继续推理，直到模型不再调用工具。
 * 工具语义与画布 MCP 保持一致，但执行不经过桥。
 */

export type AssistantToolContext = {
    canvasSnapshot: CanvasAgentSnapshot | null;
    applyOps: (ops: unknown[]) => unknown;
    navigate: NavigateFunction;
};

export const ASSISTANT_TOOL_NAMES = ["canvas_apply_ops", "canvas_get_state", "canvas_list_projects", "site_navigate", "generation_get_status"] as const;
export const ASSISTANT_TOOL_ROUND_LIMIT = ASSISTANT_MAX_TOOL_ROUNDS;

export function buildAssistantSystemPrompt(context: AssistantToolContext) {
    const hasCanvas = Boolean(context.canvasSnapshot);
    return [
        "你是「无限画布」的 AI 助手，可以直接操作用户的画布。使用中文，简洁、专业、友好。",
        "",
        "## 工具调用协议",
        "需要操作画布时，在回复中输出一个 ```tool 代码块（JSON）：",
        '```tool\n{"name": "工具名", "input": {...}}\n```',
        "每次回复至多调用一个工具，调用后等待结果再继续。能用工具完成的事不要让用户手动操作。",
        "调用工具时只输出上述代码块本身；不要输出裸 JSON、不要输出 <think> 思考过程，用户看不到这些内容。",
        "",
        "## 可用工具",
        "- canvas_apply_ops：批量修改画布。ops 支持 add_node（nodeType: text/image/config/video/audio/shot/director、title、position{x,y}、width、height、metadata）、update_node（id + patch/metadata）、delete_node（ids）、connect_nodes（fromNodeId/toNodeId）、select_nodes（ids）、set_viewport（viewport{x,y,k}）、run_generation（nodeId + mode: text/image/video/audio + prompt）。不传 x 时新节点放在画布最右侧。",
        "- canvas_get_state：读取当前画布节点、连线、选区与视口概览。",
        "- canvas_list_projects：列出全部画布工程。",
        "- site_navigate：跳转页面，path 如 /、/canvas、/canvas/:id、/image、/video、/prompts、/assets、/config。",
        "- generation_get_status：查询画布与工作台的生成任务状态。",
        "",
        "## 当前状态",
        hasCanvas
            ? `- 已打开画布「${context.canvasSnapshot?.title || "未命名"}」（projectId: ${context.canvasSnapshot?.projectId || ""}，${context.canvasSnapshot?.nodes?.length || 0} 个节点）。`
            : "- 当前页面没有打开画布：先用 canvas_list_projects 查看工程，再用 site_navigate 跳转 /canvas/:id。",
        "",
        "## 工作方式",
        "- 批量改动合并为一次 canvas_apply_ops，并在完成后用一句话说明做了什么。",
        "- 生成图片/视频：创建提示词文本节点 + config 节点并连线，对 config 节点 run_generation；生成是异步的，用 generation_get_status 查询。",
        "- 纯聊天或答疑正常回复，不调用工具。",
    ].join("\n");
}

/** 解析工具调用 JSON（容忍 name/tool 两种键名）；非法返回 null。 */
function parseToolObject(raw: string): { name: string; input: Record<string, unknown> } | null {
    try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        const name = typeof value.name === "string" ? value.name : typeof value.tool === "string" ? value.tool : "";
        if (!(ASSISTANT_TOOL_NAMES as readonly string[]).includes(name)) return null;
        const input = value.input && typeof value.input === "object" && !Array.isArray(value.input) ? (value.input as Record<string, unknown>) : {};
        return { name, input };
    } catch {
        return null;
    }
}

/**
 * 从回复文本中提取第一个工具调用并返回其在原文中的范围。
 * 容忍三种形态：```tool 围栏、```json 围栏、裸 JSON 对象；键名容忍 name/tool。
 * 部分模型不按围栏协议输出，直接裸写 {"tool": ...}，也必须能执行。
 */
export function extractAssistantToolCall(text: string): { call: { name: string; input: Record<string, unknown> }; start: number; end: number } | null {
    const keyRe = /"(?:tool|name)"\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = keyRe.exec(text))) {
        const braceStart = text.lastIndexOf("{", match.index);
        if (braceStart < 0) continue;
        // 从最近的 { 起做括号配对（跳过字符串），提取完整 JSON 对象。
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let i = braceStart; i < text.length; i += 1) {
            const ch = text[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === "{") depth += 1;
            else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end < 0) continue;
        const call = parseToolObject(text.slice(braceStart, end));
        if (call) {
            // 扩展范围吞掉包裹的围栏标记，便于展示层一并剥离。
            let start = braceStart;
            const fencePrefix = /```(?:tool|json)?\s*$/.exec(text.slice(Math.max(0, start - 12), start));
            if (fencePrefix) start -= fencePrefix[0].length;
            const fenceSuffix = /^\s*```/.exec(text.slice(end, end + 6));
            if (fenceSuffix) end += fenceSuffix[0].length;
            return { call, start, end };
        }
        keyRe.lastIndex = match.index + 1;
    }
    return null;
}

/** 解析回复中的工具调用；无合法调用返回 null。 */
export function parseAssistantToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
    return extractAssistantToolCall(text)?.call ?? null;
}

/**
 * 提取给用户看的内容：只保留目标进度与最终结论。
 * 剥离 <think> 推理块（含未闭合的 </think> 之前的一切推理）、工具调用 JSON（含围栏）。
 */
export function visibleAssistantText(text: string): string {
    let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
    // 孤立 </think>（模型只吐了闭合标记）：推理在它之前，全部裁掉。
    const closing = out.lastIndexOf("</think>");
    if (closing >= 0) out = out.slice(closing + "</think>".length);
    // 剥离工具调用块（可能连续多个，循环提取）。
    for (let found = extractAssistantToolCall(out); found; found = extractAssistantToolCall(out)) {
        out = `${out.slice(0, found.start)}${out.slice(found.end)}`;
    }
    return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** 在当前页面内执行一次助手工具调用。 */
export async function runAssistantTool(call: { name: string; input: Record<string, unknown> }, context: AssistantToolContext) {
    switch (call.name) {
        case "canvas_apply_ops": {
            if (!context.applyOps) throw new Error("当前页面没有打开画布");
            const ops = Array.isArray(call.input.ops) ? call.input.ops : [];
            return { applied: ops.length, snapshot: context.applyOps(ops) };
        }
        case "canvas_get_state": {
            if (!context.canvasSnapshot) throw new Error("当前页面没有打开画布");
            return compactSnapshot(context.canvasSnapshot);
        }
        case "site_navigate": {
            const path = typeof call.input.path === "string" ? call.input.path : "/";
            if (!path.startsWith("/")) throw new Error("无效的站点路径");
            context.navigate(path);
            return { ok: true, path };
        }
        default:
            if (isSiteTool(call.name)) return await runSiteTool(call.name, call.input, context.navigate, { canvasSnapshot: context.canvasSnapshot });
            throw new Error(`未知工具：${call.name}`);
    }
}

/** 压缩画布快照，控制回填上下文的体积。 */
function compactSnapshot(snapshot: CanvasAgentSnapshot) {
    const clampText = (value: unknown) => (typeof value === "string" && value.length > 120 ? `${value.slice(0, 120)}...` : value);
    return {
        projectId: snapshot.projectId,
        title: snapshot.title,
        viewport: snapshot.viewport,
        selectedNodeIds: (snapshot.selectedNodeIds || []).slice(0, 20),
        nodes: (snapshot.nodes || []).slice(0, 80).map((node) => ({
            id: node.id,
            type: node.type,
            title: node.title,
            position: node.position,
            width: node.width,
            height: node.height,
            metadata: Object.fromEntries(Object.entries(node.metadata || {}).map(([key, value]) => [key, clampText(value)])),
        })),
        connections: (snapshot.connections || []).slice(0, 120),
    };
}

/** 面板消息转换为 LLM 请求消息（工具结果以 system 角色回填，兼容所有网关）。 */
export function toAssistantAiMessages(systemPrompt: string, messages: AssistantMessage[]): AiTextMessage[] {
    const history: AiTextMessage[] = [{ role: "system", content: systemPrompt }];
    for (const message of messages) {
        if (message.role === "user") history.push({ role: "user", content: message.text });
        else if (message.role === "assistant" && message.text.trim()) history.push({ role: "assistant", content: message.text });
        else if (message.role === "tool") history.push({ role: "system", content: `工具 ${message.tool} 执行${message.error ? `失败：${message.error}` : "成功"}，结果：${JSON.stringify(message.result ?? null).slice(0, 4000)}` });
        else if (message.role === "error") history.push({ role: "system", content: `上一轮出错：${message.text}` });
    }
    return [history[0], ...history.slice(1).slice(-40)];
}
