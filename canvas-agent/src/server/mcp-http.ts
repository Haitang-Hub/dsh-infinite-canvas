import type express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ToolName } from "../canvas/schemas.js";
import { createCanvasMcpServer } from "./mcp.js";

/**
 * 无状态 streamable-http MCP 门面：挂载在常驻桥的 /mcp 路径上，供 Harness 的
 * dsh-mcp-client 直连。每个请求独立的 transport+server 实例，无需会话粘滞；
 * 工具调用在桥进程内直达 CanvasSession（与 /api/tools 同一执行通道）。
 *
 * 鉴权边界：本服务只绑定 127.0.0.1（见 startHttpServer 的 listen），与
 * /health、/config、/bootstrap 一样位于 token 中间件之前 —— 回环之外不可达。
 */

/** 将无状态 MCP 门面挂载到 Express 应用；session 经 callTool 执行画布工具。 */
export function registerMcpHttpEndpoint(
    app: express.Express,
    callTool: (name: ToolName, input: unknown) => Promise<unknown>,
) {
    app.post("/mcp", async (req, res) => {
        // 无状态模式：每个 POST 独立的 transport+server 实例，客户端无需维持会话。
        const server = createCanvasMcpServer(callTool);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
            void server.close();
            void transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    });
    // 无状态模式不接受 GET(SSE)/DELETE(会话终止)，按协议回 405。
    app.get("/mcp", (_req, res) => {
        res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    });
    app.delete("/mcp", (_req, res) => {
        res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    });
}
