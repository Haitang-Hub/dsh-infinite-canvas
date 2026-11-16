import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { toolDescriptions, toolInputSchemas, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, loadConfig, type CanvasAgentConfig, VERSION } from "../config.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };

/**
 * 对外 MCP 契约只暴露核心工具，控制宿主上下文占用。
 * 全量工具仍经 /api/tools 供内置面板运行时使用；长尾工具按需启用。
 * 本清单覆盖三类能力：画布读写、异步生成（run_generation 提交 + get_status 轮询，缺一不可）、
 * 镜头编排（shot_* 是与 3D 导演台协作的核心面，deskId 关联导演台实例）。
 */
export const MCP_TOOL_NAMES = [
    "site_navigate",
    "canvas_list_projects",
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_apply_ops",
    "canvas_run_generation",
    "generation_get_status",
    "canvas_export_snapshot",
    "shot_create",
    "shot_list",
    "shot_update",
    "shot_delete",
    "shot_link",
    "shot_fork",
] as const satisfies readonly ToolName[];

/**
 * 构造画布 MCP Server（stdio 与 streamable-http 门面共用）。
 * 工具调用经 callTool 回调执行：stdio 门面转发到常驻 HTTP 服务；
 * HTTP 门面在桥进程内直接调用 CanvasSession。
 */
export function createCanvasMcpServer(callTool: (name: ToolName, input: unknown) => Promise<unknown>) {
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    for (const name of MCP_TOOL_NAMES) {
        const schema = toolInputSchemas[name];
        server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
            const result = await callTool(name, schema.parse(input));
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        });
    }
    return server;
}

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const config = loadConfig(true);
    const server = createCanvasMcpServer((name, input) => postCanvasAgentTool(config, name, input));
    await server.connect(new StdioServerTransport());
}

/** 将 MCP 工具调用转发到本地 Canvas Agent HTTP 服务。 */
async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName, input: unknown) {
    const res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ name, input }) });
    const body = (await res.json()) as CanvasAgentToolResponse;
    if (!body.ok) throw new Error(body.error || "tool call failed");
    return body.result;
}
