/**
 * 面板拖动几何计算：
 * - clampPanel：拖动中限制在视口内（自由移动，无吸附）
 * - dockSideFromPanel：面板自身贴近某边（≤ PANEL_DOCK_RANGE）→ 整边停靠意图（显示预览，松手停靠）。
 *   按面板而非光标判定：光标抓在标题栏上，够不到屏幕边缘也能停靠。
 * 悬浮球仍保留左右磁吸（magnetizeFab）。
 */
export const PANEL_DOCK_RANGE = 24;

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

/** 面板贴边停靠意图：取面板最贴近且在感应范围内的边；skipSide 为本次手势拖出的一侧，不参与判定。 */
export function dockSideFromPanel(x: number, y: number, w: number, h: number, skip: DockSide | null): DockSide | null {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const candidates: Array<[DockSide, number]> = [];
    const distBottom = vh - (y + h);
    if (distBottom <= PANEL_DOCK_RANGE) candidates.push(["bottom", distBottom]);
    const distLeft = x;
    if (distLeft <= PANEL_DOCK_RANGE) candidates.push(["left", distLeft]);
    const distRight = vw - (x + w);
    if (distRight <= PANEL_DOCK_RANGE) candidates.push(["right", distRight]);
    const eligible = candidates.filter(([side]) => side !== skip);
    if (!eligible.length) return null;
    eligible.sort((a, b) => a[1] - b[1]);
    return eligible[0][0];
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
