/**
 * Harness 模型桥：画布 Agent 面板在 DSH 面板（iframe）里经 postMessage 请求宿主插件客户端，
 * 由客户端代理访问 /api/infinite-canvas.harness-* 端点。
 *
 * - provider 的 API key 只存在于 harness 进程内，页面与 canvas-agent 都拿不到；
 * - 不在 DSH 面板中时所有请求都会失败，调用方据此降级提示用自配渠道；
 * - 选择值编码进 config.agentModel 或 config.textModel：`harness::<provider>::<model>`，
 *   与渠道编码 `channelId::modelName` 区分；
 * - canvas-agent 在服务端直接回调 relay 端点（服务端到服务端，无 CORS），relay 地址由
 *   宿主客户端在响应里带回的 sourceOrigin 推得；
 * - 面板「新窗口」（URL 带 `dshWindow=1`）没有父窗口令牌，改为经同源 BroadcastChannel
 *   把请求转给面板 iframe 代发；面板关闭时请求超时。
 */

export const HARNESS_SELECTION_PREFIX = "harness::";

export type HarnessModelGroup = {
    provider: string;
    providerName: string;
    models: Array<{ id: string; name: string; description?: string }>;
};

export function encodeHarnessSelection(provider: string, model: string) {
    return `${HARNESS_SELECTION_PREFIX}${provider}::${model}`;
}

/** 解析 harness 选择值；不是 harness 编码时返回 null（走自配渠道）。 */
export function decodeHarnessSelection(value: string): { provider: string; model: string } | null {
    if (!value || !value.startsWith(HARNESS_SELECTION_PREFIX)) return null;
    const rest = value.slice(HARNESS_SELECTION_PREFIX.length);
    const sep = rest.indexOf("::");
    if (sep <= 0 || sep >= rest.length - 2) return null;
    return { provider: rest.slice(0, sep), model: rest.slice(sep + 2) };
}

const HARNESS_RELAY_PREFIX = "haitang-aigc:harness-relay:";
const HARNESS_RELAY_PROJECT = "infinite-canvas";

const childId = Math.random().toString(36).slice(2) + Date.now().toString(36);
let requestSeq = 0;
let bridgeInitialized = false;
let relayServerStarted = false;
let relayClientInitialized = false;
let cachedSourceOrigin = "";
const pending = new Map<string, { resolve: (body: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const relayPending = new Map<string, { resolve: (body: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

type RelayRequest = {
    type: "request";
    sender: string;
    requestId: string;
    action: string;
    payload?: unknown;
    timeoutMs?: number;
};
type RelayResponse = {
    type: "response";
    target: string;
    requestId: string;
    body: Record<string, unknown>;
    sourceOrigin?: string;
};

function readParam(name: string): string {
    try {
        return new URLSearchParams(window.location.search).get(name) || "";
    } catch {
        return "";
    }
}

let relayChannel: BroadcastChannel | null | undefined;
function getRelay(): BroadcastChannel | null {
    if (relayChannel !== undefined) return relayChannel;
    relayChannel = null;
    if (typeof BroadcastChannel === "undefined") return relayChannel;
    try {
        relayChannel = new BroadcastChannel(HARNESS_RELAY_PREFIX + HARNESS_RELAY_PROJECT);
    } catch {
        relayChannel = null;
    }
    return relayChannel;
}

function isEmbedded() {
    try {
        return window.self !== window.top;
    } catch {
        return false;
    }
}

/** 面板「新窗口」：没有父窗口令牌，靠同源中继找面板 iframe。 */
function isChildWindow() {
    return readParam("dshWindow") === "1";
}

function ensureBridge() {
    if (bridgeInitialized) return;
    bridgeInitialized = true;
    window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || typeof data !== "object" || data.type !== "dsh-harness:response") return;
        const requestId = String(data.requestId || "");
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        clearTimeout(entry.timer);
        if (typeof data.sourceOrigin === "string" && data.sourceOrigin) cachedSourceOrigin = data.sourceOrigin;
        entry.resolve(data as Record<string, unknown>);
    });
}

function requestFromParent(action: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    ensureBridge();
    const requestId = `harness_${Date.now()}_${(requestSeq += 1)}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("Harness 模型请求超时，请确认 DSH 插件已启用"));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        window.parent.postMessage({ type: "dsh-harness:request", requestId, action, ...(payload !== undefined ? { payload } : {}) }, "*");
    });
}

/**
 * 面板 iframe 里的中继服务：把同源新窗口的请求按普通 postMessage 发给宿主，
 * 再把宿主响应按 requestId 回给那个窗口。
 */
function ensureRelayServer() {
    if (relayServerStarted) return;
    relayServerStarted = true;
    const relay = getRelay();
    if (!relay) return;
    relay.addEventListener("message", (event) => {
        const data = event.data as RelayRequest;
        if (!data || typeof data !== "object" || data.type !== "request") return;
        if (typeof data.sender !== "string" || typeof data.requestId !== "string") return;
        const respond = (body: Record<string, unknown>) => {
            relay.postMessage({
                type: "response",
                target: data.sender,
                requestId: data.requestId,
                body,
                ...(cachedSourceOrigin ? { sourceOrigin: cachedSourceOrigin } : {}),
            });
        };
        requestFromParent(data.action, data.payload, Number(data.timeoutMs) || 30_000).then(respond, (error) =>
            respond({ ok: false, error: String(error?.message ?? error) }),
        );
    });
}

function ensureRelayClient() {
    if (relayClientInitialized) return;
    relayClientInitialized = true;
    const relay = getRelay();
    if (!relay) return;
    relay.addEventListener("message", (event) => {
        const data = event.data as RelayResponse;
        if (!data || typeof data !== "object" || data.type !== "response") return;
        if (data.target !== childId || typeof data.requestId !== "string") return;
        const entry = relayPending.get(data.requestId);
        if (!entry) return;
        relayPending.delete(data.requestId);
        clearTimeout(entry.timer);
        const body = data.body && typeof data.body === "object" ? data.body : {};
        if (typeof data.sourceOrigin === "string" && data.sourceOrigin) cachedSourceOrigin = data.sourceOrigin;
        if (typeof body.sourceOrigin === "string" && body.sourceOrigin) cachedSourceOrigin = body.sourceOrigin;
        entry.resolve(body);
    });
}

function requestViaRelay(action: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    ensureRelayClient();
    const relay = getRelay();
    if (!relay) return Promise.reject(new Error("当前浏览器不支持同源中继，无法使用 Harness 模型"));
    const requestId = `harness_${Date.now()}_${(requestSeq += 1)}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            relayPending.delete(requestId);
            reject(new Error("Harness 模型请求超时，请确认 DSH 面板保持打开"));
        }, timeoutMs);
        relayPending.set(requestId, { resolve, reject, timer });
        relay.postMessage({ type: "request", sender: childId, requestId, action, payload, timeoutMs });
    });
}

function request(action: string, payload?: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (isEmbedded()) {
        ensureBridge();
        ensureRelayServer();
        return requestFromParent(action, payload, timeoutMs);
    }
    if (isChildWindow()) return requestViaRelay(action, payload, timeoutMs);
    return Promise.reject(new Error("当前不在 DeepSeek Harness 面板中，无法使用 Harness 模型"));
}

// iframe 里立即挂上中继服务：新窗口可能先于本页发出请求。
if (typeof window !== "undefined" && isEmbedded() && readParam("dshSettingsToken")) {
    ensureRelayServer();
}

/** 拉取宿主已注册的 provider/模型分组；不在 DSH 中或宿主无可用模型时抛错。 */
export async function listHarnessModels(): Promise<HarnessModelGroup[]> {
    const body = await request("models", undefined, 15_000);
    if (body.ok !== true || !Array.isArray(body.groups)) {
        throw new Error(typeof body.error === "string" && body.error ? body.error : "无法获取 Harness 模型列表");
    }
    return (body.groups as HarnessModelGroup[]).filter((group) => group && Array.isArray(group.models) && group.models.length > 0);
}

/** canvas-agent 直连的 harness 代理端点（绝对地址）；不在 DSH 中时抛错。 */
export async function harnessRelayUrl(): Promise<string> {
    if (cachedSourceOrigin) return `${cachedSourceOrigin}/api/infinite-canvas.harness-chat`;
    await listHarnessModels();
    if (!cachedSourceOrigin) throw new Error("宿主客户端未回传地址，无法使用 Harness 模型");
    return `${cachedSourceOrigin}/api/infinite-canvas.harness-chat`;
}

/** 直接经宿主代发一次 Harness 文本对话（宿主端点非流式，返回完整文本）。 */
export async function chatHarness(selection: string, messages: unknown[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    const route = decodeHarnessSelection(selection);
    if (!route) throw new Error("不是 Harness 模型");
    if (options?.signal?.aborted) throw new Error("已取消");
    const body = await request("chat", { provider: route.provider, model: route.model, messages }, options?.timeoutMs ?? 120_000);
    if (body.ok !== true) throw new Error(typeof body.error === "string" && body.error ? body.error : "Harness 模型请求失败");
    if (options?.signal?.aborted) throw new Error("已取消");
    return typeof body.content === "string" ? body.content : "";
}

/** Agent 模型为 harness 选择时返回 canvas-agent 可用的 harness 渠道载荷，否则返回 null。 */
export async function buildHarnessChannel(selection: string): Promise<{ harness: { relay: string; provider: string; model: string } } | null> {
    const route = decodeHarnessSelection(selection);
    if (!route) return null;
    return { harness: { ...route, relay: await harnessRelayUrl() } };
}
