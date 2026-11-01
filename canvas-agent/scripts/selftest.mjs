#!/usr/bin/env node
/**
 * 桥服务自检（npm run selftest）：在临时目录 + 随机空闲端口拉起桥进程，
 * 冒烟断言插件壳依赖的对外契约——/health 自描述字段、/bootstrap 零配置发现、
 * 站点静态伺服与 token 鉴权。零新增依赖，风格对齐 build-bundle.mjs。
 *
 * 启动方式：优先 dist-bundle/index.js（发布产物），缺失时回退 npx tsx src/index.ts。
 * 全部断言 PASS 退出码 0，任一 FAIL 退出码 1；finally 杀子进程并清理临时目录。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleEntry = join(root, "dist-bundle", "index.js");
const POLL_INTERVAL_MS = 300;
const TOTAL_TIMEOUT_MS = 15000;

const results = [];
/** 记录并打印单条断言结果。 */
function check(name, pass, detail = "") {
    results.push(pass);
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` —— ${detail}` : ""}`);
}

/** 借用 net 短暂占用一次随机端口再释放，拿到当前空闲端口。 */
function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/** 带超时的 fetch，避免桥未启动或 SSE 挂起时轮询卡死。 */
async function request(url, { timeoutMs = 3000, signal, ...options } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("请求超时")), timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(signal.reason));
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** 轮询 /health 直到桥就绪（JSON 响应）或总超时。 */
async function waitUntilHealthy(baseUrl, token) {
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const res = await request(`${baseUrl}/health?token=${token}`);
            const body = await res.json();
            if (res.status === 200) return { status: res.status, body };
        } catch {
            // 桥还没监听，继续轮询。
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return { status: 0, body: null };
}

/** 结束桥进程；Windows 下 npx.cmd / node 均可能有子进程树，用 taskkill 兜底。 */
function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32") {
        try {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            return;
        } catch {
            // taskkill 不可用时退回 kill。
        }
    }
    child.kill("SIGTERM");
}

const tmpDir = mkdtempSync(join(tmpdir(), "canvas-agent-selftest-"));
// CANVAS_AGENT_HOME 一并指向临时目录，避免自检改写真实 ~/.infinite-canvas 配置。
const agentHome = join(tmpDir, "agent-home");
const env = {
    ...process.env,
    PORT: "",
    CANVAS_AGENT_HOME: agentHome,
};
let child = null;

try {
    // 1. 临时站点：只放一个含 #root 的 stub index.html（插件托管形态的最小站点）。
    writeFileSync(join(tmpDir, "index.html"), '<!doctype html><html><body><div id="root"></div></body></html>');
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 2. 拉起桥：有 bundle 产物用 process.execPath 直接跑，否则回退 npx tsx 源码模式。
    const useBundle = existsSync(bundleEntry);
    const spawnEnv = { ...env, PORT: String(port), CANVAS_SITE_DIR: tmpDir };
    if (useBundle) {
        child = spawn(process.execPath, [bundleEntry], { env: spawnEnv, stdio: "ignore" });
    } else {
        console.warn("[selftest] dist-bundle/index.js 不存在，回退 npx tsx src/index.ts");
        child = process.platform === "win32"
            // Windows 上 npx 是 .cmd，须经 shell 解析；命令合并为单串避免 DEP0190 警告。
            ? spawn("npx tsx src/index.ts", { cwd: root, env: spawnEnv, shell: true, stdio: "ignore" })
            : spawn("npx", ["tsx", "src/index.ts"], { cwd: root, env: spawnEnv, stdio: "ignore" });
    }
    child.once("error", (error) => console.warn("[selftest] 桥进程启动失败：", error.message));

    // 3. /health：probeBridge 依赖的自描述契约。
    const health = await waitUntilHealthy(baseUrl, "");
    if (health.status !== 200) {
        check("GET /health 返回 200", false, `实际 status=${health.status}`);
    } else {
        const body = health.body || {};
        check("GET /health 返回 200", true);
        check("/health ok === true", body.ok === true, `实际 ${JSON.stringify(body.ok)}`);
        check('/health plugin === "infinite-canvas"', body.plugin === "infinite-canvas", `实际 ${JSON.stringify(body.plugin)}`);
        check("/health site === true（CANVAS_SITE_DIR 已托管）", body.site === true, `实际 ${JSON.stringify(body.site)}`);
        check("/health dataDir 为非空字符串", typeof body.dataDir === "string" && body.dataDir.length > 0, `实际 ${JSON.stringify(body.dataDir)}`);
    }

    // 4. /bootstrap：零配置发现契约 { ok, url, token }。
    try {
        const res = await request(`${baseUrl}/bootstrap`);
        const body = await res.json().catch(() => ({}));
        check("GET /bootstrap 返回 200", res.status === 200, `实际 status=${res.status}`);
        check("/bootstrap 返回 token 与 url", Boolean(body.token) && Boolean(body.url), `实际 ${JSON.stringify({ token: body.token ? "<set>" : body.token, url: body.url })}`);
    } catch (error) {
        check("GET /bootstrap 返回 200", false, error.message);
        check("/bootstrap 返回 token 与 url", false, "请求失败");
    }

    // 5. 站点静态伺服：GET / 返回 index.html。
    try {
        const res = await request(`${baseUrl}/`);
        check("GET / 返回 200 且 content-type 含 text/html", res.status === 200 && String(res.headers.get("content-type") || "").includes("text/html"), `实际 status=${res.status} content-type=${res.headers.get("content-type")}`);
    } catch (error) {
        check("GET / 返回 200 且 content-type 含 text/html", false, error.message);
    }

    // 6. token 鉴权：错误 token → 401；正确 token → 非 401（/events 为 SSE，拿到响应头即断开）。
    try {
        const res = await request(`${baseUrl}/events?token=wrong-token`);
        await res.body?.cancel().catch(() => {});
        check("错误 token 访问 /events 返回 401", res.status === 401, `实际 status=${res.status}`);
    } catch (error) {
        check("错误 token 访问 /events 返回 401", false, error.message);
    }
    try {
        const bootstrap = await request(`${baseUrl}/bootstrap`);
        const { token: validToken = "" } = await bootstrap.json();
        const res = await request(`${baseUrl}/events?token=${validToken}`);
        await res.body?.cancel().catch(() => {});
        check("正确 token 访问 /events 非 401（SSE 建连成功）", res.status !== 401, `实际 status=${res.status}`);
    } catch (error) {
        check("正确 token 访问 /events 非 401（SSE 建连成功）", false, error.message);
    }
} finally {
    stopChild(child);
    rmSync(tmpDir, { recursive: true, force: true });
}

const failed = results.filter((pass) => !pass).length;
console.log(`\n[selftest] ${results.length - failed}/${results.length} 项通过`);
// 不用 process.exit 硬退：Windows 上立刻退出会撞上 libuv 关闭中的句柄
// （win/async.c 断言），设 exitCode 让事件循环自然排空。
process.exitCode = failed ? 1 : 0;
