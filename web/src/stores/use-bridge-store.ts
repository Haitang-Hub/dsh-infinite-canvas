import { create } from "zustand";

import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

/** 画布执行器对桥服务暴露的画布上下文：快照 + ops 应用/撤销能力。 */
export type BridgeCanvasContext = { snapshot: CanvasAgentSnapshot; applyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot; undoOps: () => CanvasAgentSnapshot | null; canUndo: boolean };

export type BridgeStore = {
    url: string;
    token: string;
    connected: boolean;
    /** 正在执行桥下发的工具调用（用于顶栏“执行中”徽标）。 */
    executing: boolean;
    connectError: string;
    canvasContext: BridgeCanvasContext | null;
    setBridgeState: (patch: Partial<Omit<BridgeStore, "setBridgeState" | "setCanvasContext">>) => void;
    setCanvasContext: (canvasContext: BridgeCanvasContext | null) => void;
};

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:17371";

export const useBridgeStore = create<BridgeStore>((set) => ({
    url: typeof window === "undefined" ? DEFAULT_BRIDGE_URL : localStorage.getItem("canvas-agent-url") || DEFAULT_BRIDGE_URL,
    token: typeof window === "undefined" ? "" : localStorage.getItem("canvas-agent-token") || "",
    connected: false,
    executing: false,
    connectError: "",
    canvasContext: null,
    setBridgeState: (patch) => set(patch),
    setCanvasContext: (canvasContext) => set({ canvasContext }),
}));
