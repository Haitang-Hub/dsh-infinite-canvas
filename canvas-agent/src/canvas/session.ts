import crypto from "node:crypto";
import type { ServerResponse } from "node:http";

import { appendToolLog } from "../server/tool-logs.js";
import { logger } from "../utils/logger.js";
import { buildCanvasToolRequest } from "./operations.js";
import type { ToolName } from "./schemas.js";
import { compactCanvasState, compactNode, isToolName, parseToolInput } from "./tools.js";
import type { CanvasSnapshot } from "./types.js";

/** 由画布页面执行器执行的工具；其余画布工具经 buildCanvasToolRequest 转为 canvas_apply_ops。 */
const SITE_TOOLS = new Set<ToolName>([
    "site_navigate",
    "canvas_list_projects",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
    "generation_get_status",
]);

type PendingRequest = { clientId: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
export const AGENT_PROTOCOL_VERSION = 7;

/** 执行器离线判定等待窗口：工具调用下发后 3s 内没有在线执行器即返回结构化错误。 */
const EXECUTOR_ONLINE_WAIT_MS = 3000;
/** 心跳超过该时长视为执行器失联（执行器每 15s 上报一次）。 */
const HEARTBEAT_STALE_MS = 45000;

/** 按工具类别的执行超时：状态读取类 10s，其余默认 30s。 */
const STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATUS_TOOLS = new Set<ToolName>([
    "canvas_list_projects",
    "canvas_get_state",
    "canvas_get_selection",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_video_get_config",
    "prompts_search",
    "assets_list",
]);

/** 删除类工具：桥侧记录审计日志（人在回路的确认由 harness 自身完成）。 */
const DELETE_TOOLS = new Set<ToolName>(["canvas_delete_nodes", "shot_delete"]);

/** 带结构化错误码的工具调用失败，MCP 层据此返回可引导用户的错误。 */
export class BridgeToolError extends Error {
    code: string;
    hint?: string;
    constructor(code: string, message: string, hint?: string) {
        super(message);
        this.name = "BridgeToolError";
        this.code = code;
        this.hint = hint;
    }
}

/** 管理浏览器执行器连接、画布状态快照与工具调用分发。 */
export class CanvasSession {
    private clients = new Map<string, ServerResponse>();
    private clientFocusOrder = new Map<string, number>();
    private pending = new Map<string, PendingRequest>();
    private canvasStates = new Map<string, CanvasSnapshot>();
    private heartbeats = new Map<string, number>();
    /** 每个 canvas 执行器一个 FIFO 队列：同一页面的工具调用按到达顺序串行执行，避免画布状态竞态。 */
    private queues = new Map<string, Promise<unknown>>();
    private activeClientId = "";
    private focusSequence = 0;

    /** 获取当前目标网页的画布状态。 */
    private get canvasState() {
        return this.clients.has(this.targetClientId) ? this.canvasStates.get(this.targetClientId) || null : null;
    }

    /** 获取最近激活的网页客户端。 */
    private get targetClientId() {
        return this.activeClientId;
    }

    /** 返回桥服务当前健康状态。 */
    health() {
        return {
            ok: true,
            protocolVersion: AGENT_PROTOCOL_VERSION,
            hasCanvas: Boolean(this.canvasState),
            canvasClients: this.clients.size,
            executorOnline: this.hasOnlineExecutor(),
        };
    }

    /** 是否存在活跃（SSE 在线且心跳未过期）的画布执行器。 */
    hasOnlineExecutor() {
        if (!this.clients.size) return false;
        const now = Date.now();
        return [...this.clients.keys()].some((clientId) => now - (this.heartbeats.get(clientId) || 0) < HEARTBEAT_STALE_MS);
    }

    /** 判断网页客户端是否仍连接到当前桥服务。 */
    hasClient(clientId: string) {
        return this.clients.has(clientId);
    }

    /** 建立网页与桥服务之间的 SSE 连接。 */
    openEvents(url: URL, res: ServerResponse) {
        const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
        const statusOnly = url.searchParams.get("role") === "status";
        const role = url.searchParams.get("role") === "director" ? "director" : "canvas";
        logger.info("SSE client connected", { clientId, role, statusOnly });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (!statusOnly && role !== "director") {
            this.clients.set(clientId, res);
            this.heartbeats.set(clientId, Date.now());
            if (!this.activeClientId) {
                this.activeClientId = clientId;
                this.clientFocusOrder.set(clientId, ++this.focusSequence);
            }
            if (!this.clientFocusOrder.has(clientId)) this.clientFocusOrder.set(clientId, 0);
        }
        sendEvent(res, "hello", { ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, clientId });
        const timer = setInterval(() => sendEvent(res, "ping", { time: Date.now() }), 15000);
        res.on("close", () => {
            clearInterval(timer);
            logger.info("SSE client disconnected", { clientId, role, statusOnly });
            if (statusOnly || role === "director") return;
            if (this.clients.get(clientId) !== res) return;
            this.clients.delete(clientId);
            this.heartbeats.delete(clientId);
            this.clientFocusOrder.delete(clientId);
            this.canvasStates.delete(clientId);
            this.queues.delete(clientId);
            this.pending.forEach((item, requestId) => {
                if (item.clientId !== clientId) return;
                this.pending.delete(requestId);
                item.reject(new BridgeToolError("executor_disconnected", "执行器页面已断开"));
            });
            if (this.activeClientId === clientId) this.activeClientId = [...this.clients.keys()].sort((a, b) => (this.clientFocusOrder.get(b) || 0) - (this.clientFocusOrder.get(a) || 0))[0] || "";
        });
    }

    /** 保存指定网页上报的最新画布快照。 */
    updateState(body: unknown, clientId?: string) {
        const targetClientId = clientId || this.activeClientId;
        if (!targetClientId || !this.clients.has(targetClientId)) return;
        const state = { ...((body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>), clientId: targetClientId } as CanvasSnapshot;
        this.canvasStates.set(targetClientId, state);
        logger.debug("Canvas state updated", { clientId: targetClientId, nodes: state.nodes?.length || 0, connections: state.connections?.length || 0 });
    }

    /** 刷新执行器心跳时间戳。 */
    heartbeat(clientId: string) {
        if (!this.clients.has(clientId)) return false;
        this.heartbeats.set(clientId, Date.now());
        return true;
    }

    /** 将指定网页设为最近激活的工具目标。 */
    activateClient(clientId: string) {
        if (!this.clients.has(clientId)) throw new Error("当前网页未连接");
        this.activeClientId = clientId;
        this.clientFocusOrder.set(clientId, ++this.focusSequence);
        this.heartbeats.set(clientId, Date.now());
        logger.debug("Canvas client activated", { clientId });
    }

    /** 接收网页返回的工具调用结果。 */
    resolveResult(clientId: string, body: { requestId?: string; error?: string; result?: unknown }) {
        const item = body.requestId ? this.pending.get(body.requestId) : null;
        if (!item || !body.requestId || item.clientId !== clientId) return false;
        this.pending.delete(body.requestId);
        logger.debug("Canvas tool result received", { clientId, requestId: body.requestId, error: body.error });
        body.error ? item.reject(new Error(body.error)) : item.resolve(body.result);
        return true;
    }

    /** 向全部已连接网页广播事件。 */
    emitAll(type: string, payload: unknown) {
        this.clients.forEach((client) => sendEvent(client, type, payload));
    }

    /** 校验工具参数并将调用分派到浏览器执行器。 */
    async callTool(name: unknown, rawInput: unknown) {
        const startedAt = Date.now();
        if (!isToolName(name)) throw new BridgeToolError("unknown_tool", `未知工具：${String(name)}`);
        const input = parseToolInput(name, rawInput) as Record<string, unknown>;
        logger.info("MCP tool called", { name, input, targetClientId: this.targetClientId });
        try {
            const result = await this.dispatchTool(name, input);
            this.recordToolLog({ name, input, startedAt, status: "ok" });
            return result;
        } catch (error) {
            this.recordToolLog({ name, input, startedAt, status: "error", error });
            throw error;
        }
    }

    private async dispatchTool(name: ToolName, input: Record<string, unknown>) {
        if (SITE_TOOLS.has(name)) {
            await this.ensureExecutorOnline();
            return await this.requestCanvasTool(name, input);
        }
        await this.ensureExecutorOnline();
        const readTool = ["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "shot_list"].includes(name);
        if (readTool && !this.canvasState) throw new BridgeToolError("canvas_not_ready", "当前没有已连接画布", "请先在画布页面打开一个画布工程");
        if (name === "canvas_get_state" || name === "canvas_export_snapshot") return compactCanvasState(this.canvasState);
        if (name === "shot_list") return { shots: (this.canvasState?.nodes || []).filter((node) => node.type === "shot").map(compactNode) };
        if (name === "canvas_get_selection") {
            const ids = new Set(this.canvasState?.selectedNodeIds || []);
            return { nodes: (this.canvasState?.nodes || []).filter((node) => ids.has(node.id)).map(compactNode) };
        }
        const request = buildCanvasToolRequest(name, input, this.canvasState);
        return await this.requestCanvasTool(request.name, request.input);
    }

    /** 等待执行器上线；3s 内没有画布页面在线则返回 executor_offline 结构化错误。 */
    private async ensureExecutorOnline() {
        const deadline = Date.now() + EXECUTOR_ONLINE_WAIT_MS;
        while (!this.hasOnlineExecutor() && Date.now() < deadline) await delay(100);
        if (!this.hasOnlineExecutor()) {
            throw new BridgeToolError(
                "executor_offline",
                "当前没有在线的画布执行器",
                "请先打开画布页面 http://localhost:5070 并保持页面开启，然后重试",
            );
        }
    }

    /** 将当前目标网页的工具调用串行入队后下发。 */
    private async requestCanvasTool(name: ToolName, input: Record<string, unknown>) {
        return await this.requestClientTool(this.targetClientId, name, input);
    }

    /** 向指定网页客户端发送工具请求并等待结果；请求先进入该客户端的 FIFO 队列，超时按工具类别区分。 */
    private async requestClientTool(clientId: string, name: ToolName, input: Record<string, unknown>) {
        const task = () => this.sendToolRequest(clientId, name, input);
        const previous = this.queues.get(clientId) || Promise.resolve();
        const result = previous.then(task, task);
        this.queues.set(clientId, result.catch(() => undefined));
        return await result;
    }

    private async sendToolRequest(clientId: string, name: ToolName, input: Record<string, unknown>) {
        const requestId = crypto.randomUUID();
        const client = this.clients.get(clientId);
        if (!client) throw new BridgeToolError("executor_offline", "当前没有已连接画布", "请先打开画布页面 http://localhost:5070");
        sendEvent(client, "tool_call", { requestId, name, input });
        logger.debug("Canvas tool request sent", { requestId, name, clientId });
        const timeoutMs = STATUS_TOOLS.has(name) ? STATUS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                logger.warn("Canvas tool request timed out", { requestId, name, clientId, timeoutMs });
                reject(new BridgeToolError("tool_timeout", `画布操作超时（${Math.round(timeoutMs / 1000)}s）：${name}`, "生成/导出类操作是异步的，可用 generation_get_status 等状态工具查询进度"));
            }, timeoutMs);
            this.pending.set(requestId, { clientId, resolve: (value) => (clearTimeout(timer), resolve(value)), reject: (error) => (clearTimeout(timer), reject(error)) });
        });
    }

    /** 结构化工具调用日志 + 删除类操作审计，落盘 data/logs/ 供 harness 排错。 */
    private recordToolLog(entry: { name: ToolName; input: unknown; startedAt: number; status: "ok" | "error"; error?: unknown }) {
        const summary = summarizeInput(entry.input);
        logger.info("Tool call finished", { name: entry.name, status: entry.status, durationMs: Date.now() - entry.startedAt });
        appendToolLog("tool-calls.jsonl", {
            time: new Date().toISOString(),
            tool: entry.name,
            input: summary,
            durationMs: Date.now() - entry.startedAt,
            status: entry.status,
            ...(entry.error instanceof Error ? { error: entry.error.message, code: entry.error instanceof BridgeToolError ? entry.error.code : undefined } : {}),
        });
        const deleted = deletedTargets(entry.name, entry.input);
        if (deleted) {
            appendToolLog("tool-audit.jsonl", { time: new Date().toISOString(), tool: entry.name, deleted, status: entry.status });
        }
    }
}

/** 提取删除类操作的删除目标（节点/对象/关键帧 ID），无删除时返回 null。 */
function deletedTargets(name: ToolName, input: unknown): string[] | null {
    if (DELETE_TOOLS.has(name)) {
        const data = (input || {}) as { ids?: unknown; shotNodeIds?: unknown; objectId?: unknown; cameraId?: unknown; keyframeId?: unknown };
        const ids = [data.ids, data.shotNodeIds].flatMap((value) => Array.isArray(value) ? value.map(String) : []);
        return ids;
    }
    if (name === "canvas_apply_ops" && input && typeof input === "object") {
        const ops = Array.isArray((input as { ops?: unknown }).ops) ? (input as { ops: Array<{ type?: unknown; id?: unknown; ids?: unknown }> }).ops : [];
        const ids = ops.filter((op) => op?.type === "delete_node" || op?.type === "delete_connections").flatMap((op) => [op.id, ...(Array.isArray(op.ids) ? op.ids.map(String) : [])]).filter(Boolean).map(String);
        return ids.length ? ids : null;
    }
    return null;
}

/** 压缩工具入参用于日志：仅保留主要字段并截断长文本。 */
function summarizeInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (typeof value === "string") result[key] = value.length > 200 ? `${value.slice(0, 200)}...` : value;
        else if (Array.isArray(value)) result[key] = value.length > 20 ? `Array(${value.length})` : value;
        else if (value && typeof value === "object") result[key] = `Object(${Object.keys(value).length})`;
        else result[key] = value;
    }
    return result;
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 向 SSE 连接写入一个事件。 */
function sendEvent(res: ServerResponse, type: string, payload: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
