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

/**
 * 插件壳（DSH Harness）内：请求宿主打开右侧栏「导演台」标签。
 * 宿主侧由 dsh-infinite-canvas 客户端监听并转发 `sidebarRight.openTab("director-desk", { params })`；
 * 返回 'ok'（壳已接单）；'missing'（壳在线但 openTab 抛错，通常=导演台插件未安装/未启用）；
 * 'timeout'（壳未升级或主线程繁忙，无 ACK）。调用方对后两者只提示原因，不回退独立窗口。
 */
export type ShellOpenDirectorDeskResult = "ok" | "missing" | "timeout";

export function requestShellOpenDirectorDesk(instanceId: string, timeoutMs = 2000): Promise<ShellOpenDirectorDeskResult> {
    return new Promise((resolve) => {
        const onAck = (event: MessageEvent) => {
            const data = event.data as { source?: string; type?: string; instanceId?: string } | null;
            if (data?.source !== "infinite-canvas-shell" || data.instanceId !== instanceId) return;
            if (data.type === "open-director-desk:ok") {
                cleanup();
                resolve("ok");
            } else if (data.type === "open-director-desk:missing") {
                // 壳在线但 openTab 抛错：导演台插件未安装/未启用，交给调用方提示。
                cleanup();
                resolve("missing");
            }
        };
        const cleanup = () => {
            clearTimeout(timer);
            window.removeEventListener("message", onAck);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve("timeout");
        }, timeoutMs);
        window.addEventListener("message", onAck);
        window.parent.postMessage({ source: "infinite-canvas-page", type: "open-director-desk", instanceId }, "*");
    });
}
