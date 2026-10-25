import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import i18n from "@/i18n";
import { randomId } from "@/lib/utils";
import { ensureBridgeConfig, persistBridgeConfig, type BridgeConfig } from "@/lib/agent/bridge-config";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { setDirectorHostApplyOps } from "@/lib/agent/director-desk-host";
import { activateAgentClient, postState, postToolResult } from "@/services/api/canvas-agent";
import { useBridgeStore, type BridgeCanvasContext } from "@/stores/use-bridge-store";
import { type CanvasAgentOp, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

/** 与 canvas-agent 桥服务约定的协议版本，不匹配时执行器停止工作并提示重启。 */
const AGENT_PROTOCOL_VERSION = 7;
/** 执行器心跳周期：桥据此判定执行器在线。 */
const HEARTBEAT_INTERVAL_MS = 15000;

type ToolCallPayload = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[]; path?: string } & Record<string, unknown> };
type HelloEvent = { ok?: boolean; protocolVersion?: number; clientId?: string };
type AgentClientGlobal = typeof globalThis & { __infiniteCanvasBridgeClientIdPromise?: Promise<string> };

/**
 * 画布页无界面执行器：以 canvas 角色接入本机桥服务 SSE，接收 MCP 工具调用并在浏览器中执行，
 * 用户可实时看到画布变化。挂载在全局布局，不渲染任何 UI（状态经 useBridgeStore 供顶栏徽标显示）。
 */
export function CanvasBridgeExecutor() {
    const navigate = useNavigate();
    const [clientId, setClientId] = useState("");
    const [config, setConfig] = useState<BridgeConfig | null>(null);
    const canvasContextRef = useRef<BridgeCanvasContext | null>(useBridgeStore.getState().canvasContext);

    useEffect(() => {
        let disposed = false;
        void Promise.all([acquireBridgeClientId(), ensureBridgeConfigWithOverride()]).then(([resolvedClientId, resolvedConfig]) => {
            if (disposed) return;
            setClientId(resolvedClientId);
            setConfig(resolvedConfig);
        });
        return () => {
            disposed = true;
        };
    }, []);

    // 注册导演台产物写回通道：iframe/弹窗内的导出经 postMessage 应用为当前画布 ops。
    useEffect(() => {
        setDirectorHostApplyOps(async (_projectId, ops) => {
            const context = canvasContextRef.current;
            if (!context) throw new Error("宿主画布未就绪（请确认当前页面已打开画布工程）");
            return context.applyOps(ops as CanvasAgentOp[]);
        });
        return () => setDirectorHostApplyOps(null);
    }, []);

    // 命令式订阅画布上下文，防抖上报快照；不在渲染路径订阅，避免拖拽时每帧重渲染。
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useBridgeStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            const current = useBridgeStore.getState();
            if (!current.connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void postState(current.url, current.token, clientId, canvasContextRef.current?.snapshot || null), 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [clientId, config]);

    const runToolCall = useMemo(() => {
        const endpoint = config?.url || "";
        const token = config?.token || "";
        return async (payload: ToolCallPayload) => {
            const store = useBridgeStore.getState();
            store.setBridgeState({ executing: true });
            const finish = (body: { result?: unknown; error?: string }) => {
                void postToolResult(endpoint, token, clientId, { requestId: payload.requestId, ...body });
                useBridgeStore.getState().setBridgeState({ executing: false });
            };
            try {
                let result: unknown;
                if (isSiteTool(payload.name)) {
                    result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                } else if (payload.name === "site_navigate") {
                    const path = payload.input?.path || "/";
                    navigate(path);
                    result = { ok: true, path };
                } else if (payload.name === "canvas_apply_ops") {
                    const context = canvasContextRef.current;
                    if (!context) throw new Error(i18n.t("agent.runtime.openCanvasFirst"));
                    result = context.applyOps(payload.input?.ops);
                    void postState(endpoint, token, clientId, result as CanvasAgentSnapshot);
                } else {
                    // canvas_get_state / canvas_get_selection / canvas_export_snapshot 等读取类工具直接返回快照。
                    const snapshot = canvasContextRef.current?.snapshot;
                    if (!snapshot) throw new Error(i18n.t("agent.runtime.openCanvasFirst"));
                    result = snapshot;
                }
                finish({ result });
            } catch (error) {
                finish({ error: error instanceof Error ? error.message : i18n.t("agent.runtime.toolExecutionFailed") });
            }
        };
    }, [clientId, config, navigate]);

    useEffect(() => {
        const endpoint = config?.url || "";
        const token = config?.token || "";
        if (!clientId || !config || !token) return;
        let disposed = false;
        let protocolRejected = false;
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            if (disposed) return;
            const hello = parseEventData<HelloEvent>(event);
            if (!hello || hello.protocolVersion !== AGENT_PROTOCOL_VERSION) {
                protocolRejected = true;
                source.close();
                useBridgeStore.getState().setBridgeState({ connected: false, executing: false, connectError: hello ? i18n.t("agent.runtime.versionMismatch") : "" });
                return;
            }
            useBridgeStore.getState().setBridgeState({ connected: true, executing: false, connectError: "" });
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
        });
        source.addEventListener("tool_call", (event) => {
            if (disposed) return;
            const payload = parseEventData<ToolCallPayload>(event);
            if (payload?.requestId && payload.name) void runToolCall(payload);
        });
        source.onerror = () => {
            if (disposed || protocolRejected) return;
            useBridgeStore.getState().setBridgeState({ connected: false, executing: false, connectError: i18n.t("agent.status.disconnected") });
        };
        // 执行器心跳：桥据此把连接判定为在线（SSE 断开即失效）。
        const heartbeat = setInterval(() => {
            if (disposed) return;
            void fetch(`${endpoint}/canvas/heartbeat?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST" }).catch(() => undefined);
        }, HEARTBEAT_INTERVAL_MS);
        const activate = () => {
            if (disposed || document.visibilityState !== "visible") return;
            void activateAgentClient(endpoint, token, clientId);
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activate);
        return () => {
            disposed = true;
            source.close();
            clearInterval(heartbeat);
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activate);
            useBridgeStore.getState().setBridgeState({ connected: false, executing: false });
        };
    }, [clientId, config, runToolCall]);

    return null;
}

function parseEventData<T>(event: MessageEvent) {
    try {
        return JSON.parse(event.data as string) as T;
    } catch {
        return null;
    }
}

/** URL 参数（agentUrl/agentToken，hash 或 query 均可）手动指定桥地址，优先于 /bootstrap 发现。 */
function ensureBridgeConfigWithOverride() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const query = new URLSearchParams(window.location.search);
    const url = params.get("agentUrl")?.trim() || query.get("agentUrl")?.trim() || "";
    const token = params.get("agentToken")?.trim() || query.get("agentToken")?.trim() || "";
    if (url && token) {
        const config: BridgeConfig = { url: url.replace(/\/$/, ""), token };
        persistBridgeConfig(config);
        return Promise.resolve(config);
    }
    return ensureBridgeConfig();
}

/** 跨标签页唯一且会话内稳定的执行器 ID：避免多标签页互相顶掉工具路由目标。 */
function acquireBridgeClientId() {
    const scope = globalThis as AgentClientGlobal;
    scope.__infiniteCanvasBridgeClientIdPromise ||= (async () => {
        let clientId = readStoredClientId() || randomId();
        if (!navigator.locks) {
            if (!readStoredClientId()) saveClientId(clientId);
            return clientId;
        }
        while (true) {
            const acquired = await new Promise<boolean>((resolve, reject) => {
                void navigator.locks.request(`infinite-canvas-bridge:${clientId}`, { ifAvailable: true }, async (lock) => {
                    if (!lock) return resolve(false);
                    resolve(true);
                    await new Promise<void>(() => undefined);
                }).catch(reject);
            });
            if (acquired) {
                saveClientId(clientId);
                return clientId;
            }
            clientId = randomId();
        }
    })().catch(() => {
        const clientId = randomId();
        saveClientId(clientId);
        return clientId;
    });
    return scope.__infiniteCanvasBridgeClientIdPromise;
}

function readStoredClientId() {
    try {
        return sessionStorage.getItem("canvas-bridge-client-id") || "";
    } catch {
        return "";
    }
}

function saveClientId(clientId: string) {
    try {
        sessionStorage.setItem("canvas-bridge-client-id", clientId);
    } catch {
        // 内存态身份仍能保证当前页面会话内的请求归属一致。
    }
}
