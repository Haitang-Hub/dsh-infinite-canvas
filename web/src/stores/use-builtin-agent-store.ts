import { create } from "zustand";

import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";

/** 悬浮面板几何：悬浮态坐标尺寸 + 各停靠态的厚度，全部持久化到 localStorage。 */
export type AgentPanelGeometry = {
    mode: "float" | "left" | "right" | "bottom" | "minimized";
    x: number;
    y: number;
    w: number;
    h: number;
    dockThickness: number;
};

export type BuiltinAgentMessage =
    | { id: string; role: "user"; text: string }
    | { id: string; role: "assistant"; text: string }
    | { id: string; role: "tool"; tool: string; input: unknown; result?: unknown; error?: string; round: number }
    | { id: string; role: "error"; text: string };

const STORAGE_KEY = "builtin-agent-panel";
const DEFAULT_GEOMETRY: AgentPanelGeometry = { mode: "minimized", x: 0, y: 0, w: 420, h: 560, dockThickness: 360 };
/** 单轮对话中工具执行循环上限，防止模型失控连续调用。 */
const MAX_TOOL_ROUNDS = 8;

export const BUILTIN_AGENT_MAX_TOOL_ROUNDS = MAX_TOOL_ROUNDS;

function loadGeometry(): AgentPanelGeometry {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_GEOMETRY };
        const value = { ...DEFAULT_GEOMETRY, ...(JSON.parse(raw) as Partial<AgentPanelGeometry>) };
        if (!["float", "left", "right", "bottom", "minimized"].includes(value.mode)) value.mode = "minimized";
        return value;
    } catch {
        return { ...DEFAULT_GEOMETRY };
    }
}

function saveGeometry(geometry: AgentPanelGeometry) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(geometry));
    } catch {
        // 隐私模式下不可写不影响本次会话。
    }
}

export type BuiltinAgentStore = {
    geometry: AgentPanelGeometry;
    messages: BuiltinAgentMessage[];
    streaming: boolean;
    /** 正在执行工具调用（用于悬浮球/面板状态指示）。 */
    busy: boolean;
    setGeometry: (patch: Partial<AgentPanelGeometry>) => void;
    openPanel: (mode?: AgentPanelGeometry["mode"]) => void;
    minimize: () => void;
    addMessage: (message: BuiltinAgentMessage) => void;
    updateMessage: (id: string, patch: Partial<{ text: string; result: unknown; error: string }>) => void;
    setStreaming: (streaming: boolean) => void;
    setBusy: (busy: boolean) => void;
    clearMessages: () => void;
};

export const useBuiltinAgentStore = create<BuiltinAgentStore>((set, get) => ({
    geometry: loadGeometry(),
    messages: [],
    streaming: false,
    busy: false,
    setGeometry: (patch) => {
        const geometry = { ...get().geometry, ...patch };
        saveGeometry(geometry);
        set({ geometry });
    },
    openPanel: (mode) => {
        const previous = get().geometry;
        let geometry = { ...previous, mode: mode || (previous.mode === "minimized" ? "float" : previous.mode) };
        // 首次打开（无历史坐标）默认落在视口右下角，而不是左上角。
        if (geometry.mode === "float" && !previous.x && !previous.y && typeof window !== "undefined") {
            geometry = { ...geometry, x: Math.max(16, window.innerWidth - geometry.w - 32), y: Math.max(16, window.innerHeight - geometry.h - 48) };
        }
        saveGeometry(geometry);
        set({ geometry });
    },
    minimize: () => get().setGeometry({ mode: "minimized" }),
    addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
    updateMessage: (id, patch) => set((state) => ({ messages: state.messages.map((item) => (item.id === id ? ({ ...item, ...patch } as BuiltinAgentMessage) : item)) })),
    setStreaming: (streaming) => set({ streaming }),
    setBusy: (busy) => set({ busy }),
    clearMessages: () => set({ messages: [] }),
}));

/** 供 Agent 工具协议使用的画布 ops 类型（重新导出避免各处重复引用）。 */
export type BuiltinAgentOp = CanvasAgentOp;
