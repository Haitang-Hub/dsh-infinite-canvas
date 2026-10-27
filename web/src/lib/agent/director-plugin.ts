/** 导演台插件（3d-director-desk 独立项目）地址发现：默认本机 5080，可经 config.js 覆盖。 */

type RuntimeConfig = { directorDeskUrl?: string };

export function directorDeskBaseUrl() {
    const config = (window as typeof window & { __INFINITE_CANVAS_CONFIG__?: RuntimeConfig }).__INFINITE_CANVAS_CONFIG__;
    return (config?.directorDeskUrl || "http://127.0.0.1:5080").replace(/\/$/, "");
}

/** 探测导演台服务是否可达；no-cors 模式下只要连接建立（返回 opaque response）即视为在线，不受 CORS 影响。 */
export async function directorDeskReachable(timeoutMs = 3000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        await fetch(`${directorDeskBaseUrl()}/`, { mode: "no-cors", cache: "no-store", signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
