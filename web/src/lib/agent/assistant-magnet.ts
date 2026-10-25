/**
 * 磁性吸附几何计算：悬浮面板/悬浮球拖动时对屏幕四边与四角的磁吸。
 * - MAGNET_RANGE：进入该距离后坐标被"吸"到贴边位置（配合 CSS 过渡产生回弹手感）
 * - MARGIN：贴边留白
 */
export const MAGNET_RANGE = 36;
export const MAGNET_MARGIN = 8;

export type MagnetSide = "left" | "right" | "top" | "bottom";
export type MagnetResult = { x: number; y: number; sides: MagnetSide[] };

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(min, value), Math.max(min, max));
}

/** 对悬浮面板的原始坐标做磁吸修正：靠近的边被吸附贴齐，可同时吸附两边形成贴角。 */
export function magnetizePanel(rawX: number, rawY: number, w: number, h: number): MagnetResult {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clamp(rawX, 0, vw - 120);
    let y = clamp(rawY, 0, vh - 48);
    const sides: MagnetSide[] = [];
    if (x <= MAGNET_RANGE) {
        x = MAGNET_MARGIN;
        sides.push("left");
    } else if (vw - (x + w) <= MAGNET_RANGE) {
        x = Math.max(MAGNET_MARGIN, vw - w - MAGNET_MARGIN);
        sides.push("right");
    }
    if (y <= MAGNET_RANGE) {
        y = MAGNET_MARGIN;
        sides.push("top");
    } else if (vh - (y + h) <= MAGNET_RANGE) {
        y = Math.max(MAGNET_MARGIN, vh - h - MAGNET_MARGIN);
        sides.push("bottom");
    }
    return { x, y, sides };
}

/** 悬浮球的磁吸：只在左右两侧吸附并保持垂直自由。 */
export function magnetizeFab(rawX: number, rawY: number, size: number): { x: number; y: number; side: "left" | "right" | null } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = clamp(rawX, MAGNET_MARGIN, vw - size - MAGNET_MARGIN);
    const y = clamp(rawY, MAGNET_MARGIN, vh - size - MAGNET_MARGIN);
    let side: "left" | "right" | null = null;
    if (x <= MAGNET_RANGE + 40) {
        x = MAGNET_MARGIN;
        side = "left";
    } else if (vw - (x + size) <= MAGNET_RANGE + 40) {
        x = vw - size - MAGNET_MARGIN;
        side = "right";
    }
    return { x, y, side };
}
