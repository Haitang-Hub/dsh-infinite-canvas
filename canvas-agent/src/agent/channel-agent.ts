import type { AgentAttachment, AgentEmit } from "./types.js";
import { channelToolDefinitions, skillsSystemSection, CHANNEL_SYSTEM_PROMPT, SKILL_READ_TOOL } from "./channel-tools.js";
import { loadOrCreateChannelThread, saveChannelThread, type ChannelLlmMessage, type ChannelThread } from "./channel-threads.js";

export type ChannelModelConfig = { baseUrl: string; apiKey: string; model: string };

const MAX_TOOL_ROUNDS = 10;
const TOOL_RESULT_MAX_CHARS = 8000;
/** 非流式响应的整体超时：渠道模型长思考可能超过一分钟。 */
const REQUEST_TIMEOUT_MS = 300000;

type ChatCompletionResponse = {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

let lastModel: ChannelModelConfig | null = null;
const runningTurns = new Map<string, AbortController>();

/** 渠道模型选择器数据：返回最近一次使用的渠道模型，面板据此展示模型名。 */
export function channelModels() {
    return lastModel
        ? [{ id: lastModel.model, model: lastModel.model, displayName: lastModel.model, defaultReasoningEffort: "", supportedReasoningEfforts: [], isDefault: true }]
        : [];
}

/** 中断指定线程正在运行的 turn。 */
export function interruptChannelTurn(threadId: string) {
    const controller = runningTurns.get(threadId);
    if (!controller) return false;
    controller.abort();
    return true;
}

function chatCompletionsUrl(baseUrl: string) {
    const trimmed = baseUrl.replace(/\/$/, "");
    return trimmed.endsWith("/v1") ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** 校验并规范浏览器提交的渠道配置。 */
export function channelModelConfig(value: unknown): ChannelModelConfig {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const baseUrl = String(source.baseUrl || "").trim().replace(/\/$/, "");
    const apiKey = String(source.apiKey || "").trim();
    const model = String(source.model || "").trim();
    if (!baseUrl || !apiKey || !model) throw new Error("模型渠道配置不完整：请在网页「模型配置」中选择带 API Key 的文本渠道");
    return { baseUrl, apiKey, model };
}

type RunChannelTurnOptions = {
    prompt: string;
    threadId: string;
    turnId: string;
    messageId: string;
    messageText: string;
    messageMetadata?: Record<string, unknown>;
    attachments: AgentAttachment[];
    channel: ChannelModelConfig;
    emit: AgentEmit;
    /** 工具执行入口：与 Codex 共用 session.callTool，画布写入确认仍由网页把关。 */
    callTool: (name: string, input: unknown) => Promise<unknown>;
    /** 已启用的 Skills 摘要（name+description），注入系统提示词供模型按需取用。 */
    skills?: Array<{ name: string; description: string }>;
    /** skill_read 工具的实现：按名称读取 Skill 完整指令。 */
    readSkill?: (name: string) => Promise<unknown>;
    /** turn 结束（完成/失败/中断）后的清理回调，由 HTTP 层释放会话资源。 */
    onFinish?: () => void;
};

function userLlmContent(prompt: string, attachments: AgentAttachment[]): ChannelLlmMessage["content"] {
    const images = attachments.filter((item) => item.dataUrl?.startsWith("data:image/"));
    if (!images.length) return prompt;
    return [
        { type: "text", text: prompt },
        ...images.map((item) => ({ type: "image_url", image_url: { url: item.dataUrl! } })),
    ] as unknown as string;
}

/** 运行一次渠道模型 turn：OpenAI 协议工具循环，直到模型给出最终回复。 */
export async function runChannelTurn(options: RunChannelTurnOptions): Promise<void> {
    const { prompt, threadId, turnId, messageId, messageText, messageMetadata, attachments, channel, emit, callTool } = options;
    lastModel = channel;
    const controller = new AbortController();
    runningTurns.set(threadId, controller);
    const timeout = setTimeout(() => controller.abort(new Error("模型请求超时")), REQUEST_TIMEOUT_MS);
    emit("agent_event", { type: "turn.started", turnId });
    try {
        const thread: ChannelThread = loadOrCreateChannelThread(threadId);
        if (thread.title === "新对话" && messageText.trim()) thread.title = messageText.trim().slice(0, 24);
        thread.llmMessages.push({ role: "user", content: userLlmContent(prompt, attachments) });
        thread.items.push({
            id: `${threadId}:${turnId}:synthetic:user`,
            itemId: "synthetic:user",
            clientMessageId: messageId,
            role: "user",
            text: messageText,
            turnId,
            ...(messageMetadata || {}),
        });
        const messages: ChannelLlmMessage[] = [{ role: "system", content: CHANNEL_SYSTEM_PROMPT + skillsSystemSection(options.skills || []) }, ...thread.llmMessages];
        const tools = [...channelToolDefinitions()];
        if (options.skills?.length && !tools.some((tool) => tool.function.name === SKILL_READ_TOOL.function.name)) tools.push(SKILL_READ_TOOL);

        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
            const response = await fetch(chatCompletionsUrl(channel.baseUrl), {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
                body: JSON.stringify({ model: channel.model, messages, tools, tool_choice: "auto" }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`模型请求失败（HTTP ${response.status}）${body ? `：${body.slice(0, 300)}` : ""}`);
            }
            const data = (await response.json()) as ChatCompletionResponse;
            if (data.usage) {
                emit("agent_event", {
                    type: "usage.updated",
                    usage: {
                        input_tokens: data.usage.prompt_tokens ?? 0,
                        cached_input_tokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
                        output_tokens: data.usage.completion_tokens ?? 0,
                    },
                });
            }
            const choice = data.choices?.[0]?.message;
            const toolCalls = (choice?.tool_calls || []).map((call, index) => ({
                id: String(call.id || `call-${round}-${index}`),
                type: "function" as const,
                function: { name: String(call.function?.name || ""), arguments: String(call.function?.arguments || "{}") },
            })).filter((call) => call.function.name);

            if (toolCalls.length) {
                const assistant: ChannelLlmMessage = { role: "assistant", content: choice?.content || null, tool_calls: toolCalls };
                thread.llmMessages.push(assistant);
                messages.push(assistant);
                if (choice?.content?.trim()) {
                    emit("agent_event", { type: "item.completed", item: { id: `${turnId}:msg-${round}`, type: "agent_message", text: choice.content } });
                }
                for (const call of toolCalls) {
                    let input: unknown = {};
                    try {
                        input = JSON.parse(call.function.arguments || "{}");
                    } catch {
                        input = {};
                    }
                    const item: Record<string, unknown> = { id: call.id, type: "mcp_tool_call", tool: call.function.name, arguments: input, status: "in_progress" };
                    emit("agent_event", { type: "item.updated", item: { ...item } });
                    let result: unknown;
                    let errorText = "";
                    try {
                        if (call.function.name === SKILL_READ_TOOL.function.name && options.readSkill) {
                            result = await options.readSkill(String((input as Record<string, unknown>)?.skill_name || ""));
                        } else {
                            result = await callTool(call.function.name, input);
                        }
                        item.result = result;
                        item.status = "completed";
                    } catch (error) {
                        errorText = error instanceof Error ? error.message : String(error);
                        item.error = { message: errorText };
                        item.status = "failed";
                    }
                    emit("agent_event", { type: "item.completed", item: { ...item } });
                    const output = errorText ? JSON.stringify({ error: errorText }) : JSON.stringify(result ?? { ok: true });
                    thread.llmMessages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: output.slice(0, TOOL_RESULT_MAX_CHARS) });
                    thread.items.push({
                        id: `${threadId}:${turnId}:${call.id}`,
                        itemId: call.id,
                        role: "tool",
                        title: call.function.name,
                        text: errorText || String(JSON.stringify(result ?? { ok: true })).slice(0, 200),
                        turnId,
                        detail: { kind: "tool", status: errorText ? "error" : "completed", toolCallId: call.id, output: output.slice(0, TOOL_RESULT_MAX_CHARS) },
                    });
                }
                saveChannelThread(thread);
                continue;
            }

            const text = String(choice?.content || "");
            thread.llmMessages.push({ role: "assistant", content: text });
            thread.items.push({ id: `${turnId}:final`, itemId: `${turnId}:final`, role: "assistant", text, turnId });
            emit("agent_event", { type: "item.completed", item: { id: `${turnId}:final`, type: "agent_message", text } });
            break;
        }
        saveChannelThread(thread);
        emit("agent_event", { type: "turn.completed", turnId, status: "completed" });
    } catch (error) {
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        if (aborted) {
            emit("agent_event", { type: "turn.completed", turnId, status: "interrupted" });
        } else {
            emit("agent_event", { type: "agent_error", message, turnId });
            emit("agent_event", { type: "turn.completed", turnId, status: "failed", error: { message } });
        }
    } finally {
        clearTimeout(timeout);
        runningTurns.delete(threadId);
        options.onFinish?.();
    }
}

type SkillDraft = { name: string; displayName?: string; description: string; instructions: string; shortDescription?: string; defaultPrompt?: string };

const SKILL_DRAFT_SYSTEM_PROMPT = [
    "你是 Skill 提炼助手。从给定的对话或画布上下文中提炼一个可复用的 Skill（操作指南）。",
    "Skill 面向后续的同类任务，应当写成可执行的步骤指令，而不是任务结果的描述。",
    "只输出一个 JSON 对象，不要输出其他内容，字段：",
    `- name：小写字母/数字/连字符组成的英文标识（例如 shot-storyboard）`,
    `- displayName：中文显示名（不超过 20 字）`,
    `- description：一句话说明 Skill 的用途与适用场景（不超过 200 字）`,
    `- instructions：完整步骤指令（Markdown，包含具体操作、参数与注意事项）`,
    `- shortDescription：用于技能列表的一句话简介（25-64 字）`,
    `- defaultPrompt：调用该 Skill 的默认提示词模板，必须包含 {{skill}} 占位符指向本 Skill`,
].join("\n");

/** 调用渠道模型一次性提炼 Skill 草稿；模型返回 JSON 解析失败时抛错。 */
export async function draftSkillWithChannel(channel: ChannelModelConfig, context: { source: "conversation" | "canvas"; canvasContext?: string; conversationText?: string }): Promise<SkillDraft> {
    const sourceText = context.source === "canvas"
        ? `以下是当前画布的状态快照（JSON），请提炼其中体现的可复用流程：\n${context.canvasContext || "（空）"}`
        : `以下是对话记录，请提炼其中可复用、值得固化为 Skill 的流程（如果没有可提炼内容，请让 name 为空）：\n${context.conversationText || "（空）"}`;
    const response = await fetch(chatCompletionsUrl(channel.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
        body: JSON.stringify({
            model: channel.model,
            messages: [
                { role: "system", content: SKILL_DRAFT_SYSTEM_PROMPT },
                { role: "user", content: sourceText },
            ],
            temperature: 0.2,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`提炼 Skill 失败（HTTP ${response.status}）${body ? `：${body.slice(0, 300)}` : ""}`);
    }
    const data = (await response.json()) as ChatCompletionResponse;
    const text = String(data.choices?.[0]?.message?.content || "");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("模型未返回有效的 Skill 草稿");
    const parsed = JSON.parse(jsonMatch[0]) as SkillDraft;
    if (!parsed || typeof parsed !== "object" || !parsed.name || !parsed.description || !parsed.instructions) {
        throw new Error("当前对话或画布中没有值得提炼为 Skill 的内容");
    }
    return parsed;
}
