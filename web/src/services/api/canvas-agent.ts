import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

export class AgentApiError extends Error {
    status: number;
    response: unknown;
    constructor(status: number, response: unknown) {
        const detail = response && typeof response === "object" ? (response as { error?: string; msg?: string }) : undefined;
        super(detail?.error || detail?.msg || `request failed (${status})`);
        this.name = "AgentApiError";
        this.status = status;
        this.response = response;
    }
}

/** 向桥服务上报当前画布快照（供 MCP 读取类工具与画布操作定位使用）。 */
export async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null) {
    try {
        const response = await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(snapshot ? { ...snapshot, hasCanvas: true } : { hasCanvas: false }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/** 把当前页面设为最近激活的工具目标（前台标签页优先接收 MCP 调用）。 */
export async function activateAgentClient(endpoint: string, token: string, clientId: string) {
    try {
        await fetch(`${endpoint}/canvas/activate?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST" });
    } catch {}
}

/** 回传单个工具调用的执行结果。 */
export async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetchAgentJson(endpoint, token, `/canvas/result?clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new AgentApiError(res.status, data);
    return data;
}
