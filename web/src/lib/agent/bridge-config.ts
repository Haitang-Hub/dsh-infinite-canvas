/** 画布桥服务连接配置：localStorage 优先，缺失时经 GET /bootstrap 零配置发现本机 token。 */

export type BridgeConfig = { url: string; token: string };

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:17371";

let bootstrapPromise: Promise<BridgeConfig | null> | null = null;

/** 读取已持久化的桥配置（含容错的 localStorage 访问）。 */
export function readStoredBridgeConfig(): BridgeConfig {
    let url = "";
    let token = "";
    try {
        url = (localStorage.getItem("canvas-agent-url") || "").trim();
        token = (localStorage.getItem("canvas-agent-token") || "").trim();
    } catch {
        // 隐私模式等场景下 localStorage 不可用时走 /bootstrap 发现。
    }
    return { url: (url || defaultBridgeUrl()).replace(/\/$/, ""), token };
}

/**
 * 默认桥地址：插件托管形态下页面由桥本身伺服（同源），直接用当前 origin；
 * 独立开发态（vite 5070/5075）回退到固定回环端口。
 */
function defaultBridgeUrl(): string {
    try {
        const { protocol, hostname } = window.location;
        if (protocol === "http:" || protocol === "https:") {
            if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]") {
                const port = window.location.port;
                if (port && !["5070", "5075"].includes(port)) return window.location.origin;
            }
        }
    } catch {
        // 非浏览器环境（SSR/测试）走默认端口。
    }
    return DEFAULT_BRIDGE_URL;
}

/** 向桥服务请求本机 token（仅本机回环端点），成功后持久化供后续会话使用。 */
export function fetchBridgeBootstrap(baseUrl: string): Promise<BridgeConfig | null> {
    return fetch(`${baseUrl.replace(/\/$/, "")}/bootstrap`)
        .then(async (res) => {
            if (!res.ok) return null;
            const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; token?: string } | null;
            if (!data?.ok || !data.token) return null;
            const config: BridgeConfig = { url: (data.url || baseUrl).replace(/\/$/, ""), token: data.token };
            persistBridgeConfig(config);
            return config;
        })
        .catch(() => null);
}

export function persistBridgeConfig(config: BridgeConfig) {
    try {
        localStorage.setItem("canvas-agent-url", config.url);
        localStorage.setItem("canvas-agent-token", config.token);
    } catch {
        // 写不进 localStorage 不影响本次会话使用。
    }
}

/** 确保拿到可用的桥配置：有 token 直接用，否则请求 /bootstrap 发现（同源失败再试默认端口）。 */
export function ensureBridgeConfig(): Promise<BridgeConfig | null> {
    const stored = readStoredBridgeConfig();
    if (stored.token) return Promise.resolve(stored);
    bootstrapPromise ||= (async () => {
        const viaPreferred = await fetchBridgeBootstrap(stored.url);
        if (viaPreferred) return viaPreferred;
        if (stored.url !== DEFAULT_BRIDGE_URL) return fetchBridgeBootstrap(DEFAULT_BRIDGE_URL);
        return null;
    })().finally(() => {
        bootstrapPromise = null;
    });
    return bootstrapPromise;
}
