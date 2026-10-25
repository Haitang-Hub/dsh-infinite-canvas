/**
 * 面板拖动几何计算：
 * - clampPanel：拖动中限制在视口内（自由移动，无吸附）
 * - dockSideFromPointer：指针深入屏幕边缘 DOCK_RANGE 内松手 → 整边停靠为侧栏（左/右全高、底全宽，完全贴合）
 * 悬浮球仍保留左右磁吸（magnetizeFab）。
 */
export const DOCK_RANGE = 56;

export type DockSide = "left" | "right" | "bottom";

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(min, value), Math.max(min, max));
}

/** 拖动中：限制面板完整可见（不出视口）。 */
export function clampPanel(rawX: number, rawY: number, w: number, h: number): { x: number; y: number } {
    return {
        x: clamp(rawX, 0, Math.max(0, window.innerWidth - w)),
        y: clamp(rawY, 0, Math.max(0, window.innerHeight - h)),
    };
}

/** 松手时指针所在的停靠意图区：左/右/底，深入 56px 内判定。 */
export function dockSideFromPointer(clientX: number, clientY: number): DockSide | null {
    if (clientX <= DOCK_RANGE) return "left";
    if (window.innerWidth - clientX <= DOCK_RANGE) return "right";
    if (window.innerHeight - clientY <= DOCK_RANGE) return "bottom";
    return null;
}

/** 悬浮球的磁吸：只在左右两侧吸附并保持垂直自由。 */
const FAB_SNAP_RANGE = 76;
const FAB_MARGIN = 8;

export function magnetizeFab(rawX: number, rawY: number, size: number): { x: number; y: number; side: "left" | "right" | null } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clamp(rawX, FAB_MARGIN, vw - size - FAB_MARGIN);
    const y = clamp(rawY, FAB_MARGIN, vh - size - FAB_MARGIN);
    let side: "left" | "right" | null = null;
    if (x <= FAB_SNAP_RANGE) {
        x = FAB_MARGIN;
        side = "left";
    } else if (vw - (x + size) <= FAB_SNAP_RANGE) {
        x = vw - size - FAB_MARGIN;
        side = "right";
    }
    return { x, y, side };
}
