import { create } from "zustand";

import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";

/**
 * AI 助手（悬浮对话面板）状态模型：
 * - 几何：悬浮坐标尺寸 / 悬浮球位置，持久化
 * - 外观：毛玻璃透明度 / 紧凑模式 / 模型，持久化
 * - 会话：消息、流式与工具执行状态（内存态）
 */

export type AssistantGeometry = {
    mode: "float" | "minimized";
    x: number;
    y: number;
    w: number;
    h: number;
    /** 悬浮球位置（未拖动过时为空，按默认右下渲染）。 */
    fabX: number;
    fabY: number;
};

export type AssistantStyle = {
    /** 毛玻璃透明度（0-90）。 */
    glass: number;
    compact: boolean;
    /** 对话使用的文本模型；空串表示跟随全局配置。 */
    model: string;
};

export type AssistantMessage =
    | { id: string; role: "user"; text: string }
    | { id: string; role: "assistant"; text: string }
    | { id: string; role: "tool"; tool: string; input: unknown; result?: unknown; error?: string; round: number }
    | { id: string; role: "error"; text: string };

const GEOMETRY_KEY = "ai-assistant-geometry";
const STYLE_KEY = "ai-assistant-style";
const DEFAULT_GEOMETRY: AssistantGeometry = { mode: "minimized", x: 0, y: 0, w: 430, h: 580, fabX: 0, fabY: 0 };
const DEFAULT_STYLE: AssistantStyle = { glass: 20, compact: false, model: "" };

/** 单轮对话工具执行循环上限。 */
export const ASSISTANT_MAX_TOOL_ROUNDS = 8;
function persisted<T>(key: string, base: T, isValid: (value: T) => T): T {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return { ...base };
        return isValid({ ...base, ...(JSON.parse(raw) as Partial<T>) });
    } catch {
        return { ...base };
    }
}

function persist(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // 隐私模式等场景下写入失败不影响本次会话。
    }
}

function loadGeometry() {
    // 旧版本持久化里可能存在 left/right/bottom 停靠模式，统一回落为悬浮。
    return persisted(GEOMETRY_KEY, DEFAULT_GEOMETRY, (value) => {
        if (value.mode !== "float" && value.mode !== "minimized") value.mode = "minimized";
        // 坐标可能来自更大的视口：加载时夹取回当前视口，避免面板落在屏幕外。
        if (typeof window !== "undefined") {
            value.w = Math.min(value.w, window.innerWidth - 16);
            value.h = Math.min(value.h, window.innerHeight - 16);
            value.x = Math.min(Math.max(0, value.x), Math.max(0, window.innerWidth - value.w));
            value.y = Math.min(Math.max(0, value.y), Math.max(0, window.innerHeight - value.h));
            if (!value.x && !value.y) {
                value.x = Math.max(16, window.innerWidth - value.w - 28);
                value.y = Math.max(16, window.innerHeight - value.h - 88);
            }
            if (value.fabX || value.fabY) {
                const size = 52;
                value.fabX = Math.min(Math.max(0, value.fabX), Math.max(0, window.innerWidth - size));
                value.fabY = Math.min(Math.max(0, value.fabY), Math.max(0, window.innerHeight - size));
            }
        }
        return value;
    });
}

function loadStyle() {
    return persisted(STYLE_KEY, DEFAULT_STYLE, (value) => {
        value.glass = Math.min(90, Math.max(0, Number(value.glass) || 0));
        value.compact = Boolean(value.compact);
        if (typeof value.model !== "string") value.model = "";
        return value;
    });
}

export type AiAssistantStore = {
    geometry: AssistantGeometry;
    style: AssistantStyle;
    messages: AssistantMessage[];
    streaming: boolean;
    busy: boolean;
    setGeometry: (patch: Partial<AssistantGeometry>) => void;
    setStyle: (patch: Partial<AssistantStyle>) => void;
    open: (mode?: AssistantGeometry["mode"]) => void;
    minimize: () => void;
    addMessage: (message: AssistantMessage) => void;
    patchMessage: (id: string, patch: Partial<{ text: string; result: unknown; error: string }>) => void;
    setStreaming: (streaming: boolean) => void;
    setBusy: (busy: boolean) => void;
    clearMessages: () => void;
};

export const useAiAssistantStore = create<AiAssistantStore>((set, get) => ({
    geometry: loadGeometry(),
    style: loadStyle(),
    messages: [],
    streaming: false,
    busy: false,
    setGeometry: (patch) => {
        const geometry = { ...get().geometry, ...patch };
        persist(GEOMETRY_KEY, geometry);
        set({ geometry });
    },
    setStyle: (patch) => {
        const style = { ...get().style, ...patch };
        persist(STYLE_KEY, style);
        set({ style });
    },
    open: (mode) => {
        const previous = get().geometry;
        let geometry = { ...previous, mode: mode || (previous.mode === "minimized" ? "float" : previous.mode) };
        // 首次打开无历史坐标时默认落在视口右下角。
        if (geometry.mode === "float" && !previous.x && !previous.y && typeof window !== "undefined") {
            geometry = { ...geometry, x: Math.max(16, window.innerWidth - geometry.w - 28), y: Math.max(16, window.innerHeight - geometry.h - 88) };
        }
        persist(GEOMETRY_KEY, geometry);
        set({ geometry });
    },
    minimize: () => get().setGeometry({ mode: "minimized" }),
    addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
    patchMessage: (id, patch) => set((state) => ({ messages: state.messages.map((item) => (item.id === id ? ({ ...item, ...patch } as AssistantMessage) : item)) })),
    setStreaming: (streaming) => set({ streaming }),
    setBusy: (busy) => set({ busy }),
    clearMessages: () => set({ messages: [] }),
}));

/** 面向工具引擎的画布 ops 类型别名。 */
export type AssistantCanvasOp = CanvasAgentOp;
