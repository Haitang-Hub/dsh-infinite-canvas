import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeToolError } from "../canvas/session.js";
import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "../config.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string; code?: string; hint?: string };

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const config = loadConfig(true);
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, config, name));
    await server.connect(new StdioServerTransport());
}

/** 向 MCP Server 注册单个画布工具；执行器离线等结构化错误以 isError 结果返回。 */
function registerCanvasTool(server: McpServer, config: CanvasAgentConfig, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        try {
            const result = await postCanvasAgentTool(config, name, schema.parse(input));
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            if (error instanceof BridgeToolError) {
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: JSON.stringify({ error: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) }, null, 2) }],
                };
            }
            throw error;
        }
    });
}

/** 将 MCP 工具调用转发到本地画布桥服务。 */
async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName, input: unknown) {
    let res: Response;
    try {
        res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ name, input }) });
    } catch {
        throw new BridgeToolError("bridge_offline", "画布桥服务未启动或无响应", "先运行 canvas-agent（或 start.bat）启动桥服务，再重试");
    }
    const body = (await res.json().catch(() => ({}))) as CanvasAgentToolResponse;
    if (!res.ok || !body.ok) {
        // 桥返回的结构化错误码（如 executor_offline）原样透传给 harness，便于引导用户。
        if (body.code) throw new BridgeToolError(body.code, body.error || "tool call failed", body.hint);
        throw new Error(body.error || "tool call failed");
    }
    return body.result;
}
