import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../config.js";

/** 渠道模型 Agent 的会话消息（OpenAI Chat Completions 形态）。 */
export type ChannelLlmMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
    name?: string;
};

/** 面板时间线使用的消息条目（与网页 AgentChatItem 对齐）。 */
export type ChannelThreadItem = {
    id: string;
    itemId: string;
    clientMessageId?: string;
    role: "user" | "assistant" | "tool" | "error";
    title?: string;
    text: string;
    turnId: string;
    detail?: Record<string, unknown>;
};

export type ChannelThread = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** 发送给渠道模型的完整消息序列。 */
    llmMessages: ChannelLlmMessage[];
    /** 面板渲染/历史回放使用的条目。 */
    items: ChannelThreadItem[];
};

const THREADS_DIR = path.join(CONFIG_DIR, "channel-threads");

function threadFile(threadId: string) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(threadId)) throw new Error(`无效的会话 ID：${threadId}`);
    return path.join(THREADS_DIR, `${threadId}.json`);
}

function readThreadFile(threadId: string): ChannelThread | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(threadFile(threadId), "utf8")) as ChannelThread;
        if (!parsed?.id || !Array.isArray(parsed.llmMessages) || !Array.isArray(parsed.items)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeThreadFile(thread: ChannelThread) {
    fs.mkdirSync(THREADS_DIR, { recursive: true });
    thread.updatedAt = new Date().toISOString();
    fs.writeFileSync(threadFile(thread.id), JSON.stringify(thread, null, 2), "utf8");
    return thread;
}

/** 列出全部会话（按更新时间倒序）。 */
export function listChannelThreads(): Array<{ id: string; title: string; createdAt: number; updatedAt: number; preview: string }> {
    try {
        return fs
            .readdirSync(THREADS_DIR)
            .filter((file) => file.endsWith(".json"))
            .map((file) => readThreadFile(file.slice(0, -5)))
            .filter((thread): thread is ChannelThread => Boolean(thread))
            .map((thread) => ({
                id: thread.id,
                title: thread.title,
                createdAt: Date.parse(thread.createdAt) || 0,
                updatedAt: Date.parse(thread.updatedAt) || 0,
                preview: thread.title,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
}

export function readChannelThread(threadId: string): ChannelThread | null {
    return readThreadFile(threadId);
}

/** 新建空会话。 */
export function createChannelThread(): ChannelThread {
    const thread: ChannelThread = {
        id: crypto.randomUUID(),
        title: "新对话",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        llmMessages: [],
        items: [],
    };
    return writeThreadFile(thread);
}

/** 载入会话（不存在时新建），用于 turn 开始。 */
export function loadOrCreateChannelThread(threadId: string): ChannelThread {
    return readThreadFile(threadId) ?? createChannelThread();
}

export function saveChannelThread(thread: ChannelThread) {
    return writeThreadFile(thread);
}

export function deleteChannelThread(threadId: string) {
    try {
        fs.rmSync(threadFile(threadId), { force: true });
    } catch {
        // 文件不存在或被占用时忽略删除失败
    }
}
