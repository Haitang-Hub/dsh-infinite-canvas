/** 导演台插件（3d-director-desk 独立项目）地址发现：默认本机 5080，可经 config.js 覆盖。 */

type RuntimeConfig = { directorDeskUrl?: string };

export function directorDeskBaseUrl() {
    const config = (window as typeof window & { __INFINITE_CANVAS_CONFIG__?: RuntimeConfig }).__INFINITE_CANVAS_CONFIG__;
    return (config?.directorDeskUrl || "http://127.0.0.1:5080").replace(/\/$/, "");
}
