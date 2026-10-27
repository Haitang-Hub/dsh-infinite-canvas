import { zodToJsonSchema } from "zod-to-json-schema";

import { AGENT_PROMPT } from "../config.js";
import { toolDescriptions, toolInputSchemas, toolNames } from "../canvas/schemas.js";

export type ChannelToolDefinition = {
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** 渠道模型 Agent 的系统提示词：与 MCP 版共用画布操作说明。 */
export const CHANNEL_SYSTEM_PROMPT = AGENT_PROMPT;

/** 把 canvas-agent 的全部工具转成 OpenAI function calling 工具表；执行仍经 session.callTool 分发到网页。 */
export function channelToolDefinitions(): ChannelToolDefinition[] {
    return toolNames.map((name) => ({
        type: "function" as const,
        function: {
            name,
            description: toolDescriptions[name],
            parameters: zodToJsonSchema(toolInputSchemas[name], { $refStrategy: "none" }) as Record<string, unknown>,
        },
    }));
}
