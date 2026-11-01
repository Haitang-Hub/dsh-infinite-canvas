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
    return [...toolNames.map((name) => ({
        type: "function" as const,
        function: {
            name,
            description: toolDescriptions[name],
            parameters: zodToJsonSchema(toolInputSchemas[name], { $refStrategy: "none" }) as Record<string, unknown>,
        },
    })), SKILL_READ_TOOL];
}

/** 渠道引擎内置工具：按需读取 Skill 完整指令（Skill 全文较大，系统提示词只注入摘要）。 */
export const SKILL_READ_TOOL: ChannelToolDefinition = {
    type: "function",
    function: {
        name: "skill_read",
        description: "读取指定 Skill 的完整指令内容。当任务匹配某个可用 Skill 时，先调用本工具获取完整步骤，再按指令执行。",
        parameters: {
            type: "object",
            properties: { skill_name: { type: "string", description: "Skill 的名称（可用 Skills 列表中的 name）" } },
            required: ["skill_name"],
        },
    },
};

/** 生成注入系统提示词的 Skills 段落；无可用 Skill 时返回空字符串。 */
export function skillsSystemSection(skills: Array<{ name: string; description: string }>): string {
    if (!skills.length) return "";
    const lines = skills.map((skill) => `- ${skill.name}：${skill.description}`);
    return [
        "",
        "## 可用 Skills",
        "以下 Skill 已启用。任务匹配某个 Skill 时，先调用 skill_read 工具（参数 skill_name）读取完整指令，再严格按指令执行：",
        ...lines,
    ].join("\n");
}
