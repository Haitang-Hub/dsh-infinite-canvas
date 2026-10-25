/**
 * 面板拖动几何计算：
 * - clampPanel：拖动中限制在视口内（自由移动，无吸附）
 * - snapPanelToEdge：松手时距边缘 SNAPPX 内则贴边停靠（完全贴齐，无留白无回弹）
 * 悬浮球仍保留左右磁吸（magnetizeFab）。
 */
export const EDGE_SNAP_RANGE = 56;

export type DockSide = "left" | "right" | "top" | "bottom";
export type SnapResult = { x: number; y: number; sides: DockSide[] };

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(min, value), Math.max(min, max));
}

/** 拖动中：仅限制面板在视口内。 */
export function clampPanel(rawX: number, rawY: number, w: number, h: number): { x: number; y: number } {
    return {
        x: clamp(rawX, 0, Math.max(0, window.innerWidth - 120)),
        y: clamp(rawY, 0, Math.max(0, window.innerHeight - 48)),
    };
}

/** 松手时：靠近的边贴齐停靠（x=0 / 右边贴右边框等），可同时贴两边成贴角。 */
export function snapPanelToEdge(rawX: number, rawY: number, w: number, h: number): SnapResult {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = clampPanel(rawX, rawY, w, h);
    const sides: DockSide[] = [];
    if (x <= EDGE_SNAP_RANGE) {
        x = 0;
        sides.push("left");
    } else if (vw - (x + w) <= EDGE_SNAP_RANGE) {
        x = Math.max(0, vw - w);
        sides.push("right");
    }
    if (y <= EDGE_SNAP_RANGE) {
        y = 0;
        sides.push("top");
    } else if (vh - (y + h) <= EDGE_SNAP_RANGE) {
        y = Math.max(0, vh - h);
        sides.push("bottom");
    }
    return { x, y, sides };
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
