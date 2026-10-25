import type { NavigateFunction } from "react-router-dom";

import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { BUILTIN_AGENT_MAX_TOOL_ROUNDS, type BuiltinAgentMessage } from "@/stores/use-builtin-agent-store";
import type { AiTextMessage } from "@/services/api/image";

/**
 * 内置 Agent 的画布工具协议：模型在回复中以 ```tool 代码块声明调用，
 * 前端解析执行后把结果以 system 角色回填继续对话，直到模型不再调用工具。
 * （复用 MCP 侧同一套工具语义，但执行在本页面内完成，不经过桥。）
 */

export type BuiltinToolContext = {
    canvasSnapshot: CanvasAgentSnapshot | null;
    applyOps: (ops: unknown[]) => unknown;
    navigate: NavigateFunction;
};

export const BUILTIN_TOOL_NAMES = ["canvas_apply_ops", "canvas_get_state", "canvas_list_projects", "site_navigate", "generation_get_status"] as const;

export function buildSystemPrompt(context: BuiltinToolContext) {
    const hasCanvas = Boolean(context.canvasSnapshot);
    return [
        "你是无限画布的内置创作助手，可以直接操作用户的画布。回复使用中文，简洁友好。",
        "",
        "## 工具调用协议",
        "需要操作画布时，在回复中输出一个 ```tool 代码块（JSON）：",
        '```tool\n{"name": "工具名", "input": {...}}\n```',
        "每次回复至多调用一个工具；调用后等待系统返回结果再继续。能用工具完成就不要让用户手动操作。",
        "",
        "## 可用工具",
        "- canvas_apply_ops：批量修改画布。ops 数组支持 add_node（nodeType: text/image/config/video/audio/shot/director、title、position{x,y}、width、height、metadata）、update_node（id + patch/metadata）、delete_node（ids）、connect_nodes（fromNodeId/toNodeId）、select_nodes（ids）、set_viewport（viewport{x,y,k}）、run_generation（nodeId + mode: text/image/video/audio + prompt）。不传 x 时新节点放在画布最右侧。",
        "- canvas_get_state：读取当前画布的节点、连线、选区与视口概览。",
        "- canvas_list_projects：列出全部画布工程（标题、节点数等）。",
        "- site_navigate：跳转站点页面，path 如 /、/canvas、/canvas/:id、/image、/video、/prompts、/assets、/config。",
        "- generation_get_status：查询画布与工作台的生成任务状态。",
        "",
        `## 当前状态`,
        `- 当前页面${hasCanvas ? `已打开画布「${context.canvasSnapshot?.title || "未命名"}」（projectId: ${context.canvasSnapshot?.projectId || ""}，${context.canvasSnapshot?.nodes?.length || 0} 个节点）` : "没有打开画布；操作画布前先用 canvas_list_projects 查看，再用 site_navigate 跳转 /canvas/:id"}。`,
        "",
        "## 建议",
        "- 用户要「加几个文本节点/连起来/摆个流程」时，直接用 canvas_apply_ops 一次性完成，并简述做了什么。",
        "- 用户要生成图片/视频时：创建文本节点（提示词）+ config 节点并连线，再对 config 节点 run_generation；生成是异步的，之后可用 generation_get_status 查询。",
        "- 纯聊天/答疑时正常回复即可，不要调用工具。",
    ].join("\n");
}

/** 从模型回复文本中解析 ```tool 代码块；无调用返回 null。 */
export function parseToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
    const match = text.match(/```tool\s*\n([\s\S]*?)```/);
    if (!match) return null;
    try {
        const value = JSON.parse(match[1].trim()) as { name?: unknown; input?: unknown };
        const name = typeof value.name === "string" ? value.name : "";
        if (!(BUILTIN_TOOL_NAMES as readonly string[]).includes(name)) return null;
        return { name, input: value.input && typeof value.input === "object" && !Array.isArray(value.input) ? value.input as Record<string, unknown> : {} };
    } catch {
        return null;
    }
}

/** 在浏览器内执行一次内置工具调用，返回结果或抛错。 */
export async function runBuiltinTool(call: { name: string; input: Record<string, unknown> }, context: BuiltinToolContext) {
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
            // canvas_list_projects / generation_get_status 与站点工具共用浏览器执行器实现。
            if (isSiteTool(call.name)) return await runSiteTool(call.name, call.input, context.navigate, { canvasSnapshot: context.canvasSnapshot });
            throw new Error(`未知工具：${call.name}`);
    }
}

/** 压缩画布快照，避免把大段内容塞回对话上下文。 */
function compactSnapshot(snapshot: CanvasAgentSnapshot) {
    const clampText = (value: unknown) => typeof value === "string" && value.length > 120 ? `${value.slice(0, 120)}...` : value;
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

/** 把面板消息 + 工具结果转换为 LLM 请求消息（工具结果以 system 角色回填，兼容所有网关）。 */
export function toAiMessages(systemPrompt: string, messages: BuiltinAgentMessage[]): AiTextMessage[] {
    const result: AiTextMessage[] = [{ role: "system", content: systemPrompt }];
    for (const message of messages) {
        if (message.role === "user") result.push({ role: "user", content: message.text });
        else if (message.role === "assistant" && message.text.trim()) result.push({ role: "assistant", content: message.text });
        else if (message.role === "tool") result.push({ role: "system", content: `工具 ${message.tool} 执行${message.error ? `失败：${message.error}` : "成功"}，结果：${JSON.stringify(message.result ?? null).slice(0, 4000)}` });
        else if (message.role === "error") result.push({ role: "system", content: `上一轮出错：${message.text}` });
    }
    // 截断历史，保留 system 与最近 40 条，避免上下文膨胀。
    return [result[0], ...result.slice(1).slice(-40)];
}

export const MAX_TOOL_ROUNDS = BUILTIN_AGENT_MAX_TOOL_ROUNDS;
