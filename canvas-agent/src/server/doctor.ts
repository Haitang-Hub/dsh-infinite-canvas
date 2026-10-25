import { AGENT_PROTOCOL_VERSION } from "../canvas/session.js";
import { DEFAULT_PORT, loadConfig, VERSION } from "../config.js";
import { checkDataDirWritable } from "./tool-logs.js";

type HealthResponse = { ok?: boolean; protocolVersion?: number; canvasClients?: number; directorClients?: number; executorOnline?: boolean };

/** 一键自检：桥服务在线、执行器在线、data 目录可写、协议版本匹配，输出人类可读报告。 */
export async function runDoctor() {
    const config = loadConfig(false);
    const lines: string[] = [];
    const fail = (text: string) => lines.push(`  ✗ ${text}`);

    // 1. 桥服务在线
    let health: HealthResponse | null = null;
    try {
        const res = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(3000) });
        health = res.ok ? (await res.json()) as HealthResponse : null;
    } catch {
        health = null;
    }
    if (health?.ok) {
        lines.push(`✓ 桥服务在线：${config.url}`);
        if (health.protocolVersion !== AGENT_PROTOCOL_VERSION) fail(`桥服务协议版本不匹配：服务 ${health.protocolVersion}，MCP ${AGENT_PROTOCOL_VERSION}，请同仓库升级后重启`);
        else lines.push(`  协议版本：v${health.protocolVersion}`);
    } else {
        fail(`桥服务未启动或无响应：${config.url}`);
        lines.push(`  启动方式：运行 start.bat，或 node canvas-agent/dist/index.js（默认端口 ${DEFAULT_PORT}）`);
    }

    // 2. 浏览器执行器在线
    if (health?.ok) {
        if (health.executorOnline) {
            lines.push(`✓ 画布执行器在线（${health.canvasClients} 个画布页面，${health.directorClients} 个导演台页面）`);
        } else {
            fail("画布执行器离线：没有打开的画布页面（或心跳超时）");
            lines.push("  请打开 http://localhost:5070 并进入画布页，MCP 工具在浏览器中执行");
        }
    }

    // 3. data 目录可写
    const dataDir = checkDataDirWritable();
    if (dataDir.ok) lines.push(`✓ data 目录可写：${dataDir.dir}`);
    else fail(`data 目录不可写：${dataDir.dir}${"error" in dataDir ? `（${dataDir.error}）` : ""}`);

    // 4. token 通道
    lines.push(config.token ? `✓ 连接 token 已配置（~/.infinite-canvas/canvas-agent.json）` : "✗ 连接 token 未配置：请先启动一次桥服务生成 token");

    console.log(`Infinite Canvas MCP doctor（v${VERSION}）`);
    console.log(lines.join("\n"));
    const failed = lines.some((line) => line.startsWith("  ✗"));
    if (failed) {
        console.log("\n存在未通过项，请按提示处理后重试。");
        process.exitCode = 1;
    } else {
        console.log("\n全部检查通过，MCP 可以正常调用画布工具。");
    }
}
