import express, { type NextFunction, type Request, type Response } from "express";

import { AGENT_PROTOCOL_VERSION, BridgeToolError, CanvasSession } from "../canvas/session.js";
import { loadConfig, saveConfig, writeTokenFile, type CanvasAgentConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { createMediaServeRouter, createStoreRouter } from "./store.js";

/** 启动仅监听本机的画布桥服务：MCP 工具调用经此分发给在线的浏览器执行器。 */
export function startHttpServer() {
    const config = loadConfig(true);
    const port = Number(process.env.PORT) || Number(new URL(config.url).port) || 17371;
    config.url = `http://127.0.0.1:${port}`;
    saveConfig(config);
    writeTokenFile(config.token);

    const session = new CanvasSession();
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "30mb" }));
    app.use((req, res, next) => {
        if (!logger.enabled) return next();
        const startedAt = Date.now();
        const url = requestUrl(req, config);
        res.on("finish", () => {
            if (req.method === "OPTIONS" || (res.statusCode < 400 && ["/health", "/canvas/state", "/canvas/heartbeat"].includes(url.pathname))) return;
            logger.debug(`HTTP ${req.method} ${url.pathname}`, { status: res.statusCode, durationMs: Date.now() - startedAt });
        });
        next();
    });
    app.use((req, res, next) => {
        const url = requestUrl(req, config);
        if (!setCors(req, res, url, config)) return void res.status(403).json({ ok: false, error: "origin not allowed" });
        if (req.method === "OPTIONS") return void res.json({});
        next();
    });
    // 本机回环免 token 端点：健康检查、配置发现、本地文件存储（页面零配置）。
    app.get("/health", (_req, res) => res.json(session.health()));
    app.get("/config", (_req, res) => res.json({ ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, url: config.url, hasToken: true }));
    app.get("/bootstrap", (_req, res) => res.json({ ok: true, protocolVersion: AGENT_PROTOCOL_VERSION, url: config.url, token: config.token }));
    app.use("/store", createStoreRouter());
    app.use("/media", createMediaServeRouter());
    app.use((req, res, next) => {
        if (validToken(req, requestUrl(req, config), config.token)) return next();
        res.status(401).json({ ok: false, error: "invalid token" });
    });
    app.get("/events", (req, res) => {
        session.openEvents(requestUrl(req, config), res);
    });
    app.post("/canvas/state", (req, res) => {
        session.updateState(req.body, String(req.query.clientId || "") || undefined);
        res.json({ ok: true });
    });
    app.post("/canvas/activate", (req, res) => {
        try {
            session.activateClient(String(req.query.clientId || ""));
            res.json({ ok: true });
        } catch (error) {
            res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.post("/canvas/heartbeat", (req, res) => {
        res.json({ ok: session.heartbeat(String(req.query.clientId || "")) });
    });
    app.post("/canvas/result", (req, res) => {
        const ok = session.resolveResult(String(req.query.clientId || ""), req.body);
        res.status(ok ? 200 : 409).json({ ok });
    });
    app.post("/director/ready", (req, res) => {
        const ok = session.markDirectorReady(String(req.body?.clientId || ""), String(req.body?.deskId || ""));
        res.status(ok ? 200 : 404).json({ ok });
    });
    app.post("/api/tools", route(async (req, res) => res.json({ ok: true, result: await session.callTool(req.body?.name, req.body?.input || {}) })));
    app.use((_req, res) => res.status(404).json({ ok: false, error: "not found" }));
    app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
        logger.error("HTTP request failed", { method: req.method, path: req.path, error });
        if (error instanceof BridgeToolError) return void res.status(500).json({ ok: false, error: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) });
        res.status(500).json({ ok: false, error: error.message });
    });

    app.listen(port, "127.0.0.1", () => {
        console.log("Infinite Canvas Bridge");
        console.log(`Local URL: ${config.url}`);
        console.log(`Connect token: ${config.token}`);
        console.log(`MCP: node ${process.argv[1]} mcp  (或 canvas-agent mcp)`);
        console.log(`Doctor: node ${process.argv[1]} doctor`);
        if (logger.enabled) console.log(`Debug log: ${logger.filePath}`);
        logger.info("Canvas bridge started", { url: config.url, debugLog: logger.filePath });
    });
}

/** 将异步 Express 路由异常交给统一错误处理中间件。 */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next);
}

/** 结合服务配置解析当前请求 URL。 */
function requestUrl(req: Request, config: CanvasAgentConfig) {
    return new URL(req.originalUrl || req.url || "/", config.url);
}

/** 设置跨域响应头并记录通过 token 授权的来源。 */
function setCors(req: Request, res: Response, url: URL, config: CanvasAgentConfig) {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-canvas-agent-token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (!origin || req.method === "OPTIONS" || url.pathname === "/health" || url.pathname === "/config" || url.pathname === "/bootstrap") return true;
    config.origins ||= [];
    if (validToken(req, url, config.token) && !config.origins.includes(origin)) {
        config.origins.push(origin);
        saveConfig(config);
    }
    res.setHeader("Vary", "Origin");
    return config.origins.includes(origin);
}

/** 校验请求查询参数或请求头中的连接 token。 */
function validToken(req: Request, url: URL, token: string) {
    const header = req.headers["x-canvas-agent-token"];
    return url.searchParams.get("token") === token || header === token || (Array.isArray(header) && header.includes(token));
}
