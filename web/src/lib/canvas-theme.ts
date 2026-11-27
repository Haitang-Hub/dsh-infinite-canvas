import { designTokens, roleColors } from "./design-tokens";

export type CanvasColorTheme = "light" | "dark";
export type CanvasBackgroundMode = "dots" | "lines" | "blank";

/**
 * 画布配色：不再是独立的暖灰一套，全部来自 DSH 设计令牌（design-tokens.ts）。
 * 组件拿到的 `theme` 除画布/节点/工具栏外，还带 state（状态色）与 role（节点类型色），
 * 避免各组件再写死 #ef4444 / #22c55e 之类的散落色值。
 */
export const canvasThemes = {
    light: {
        canvas: {
            background: designTokens.light.bgCanvas,
            dot: "rgba(15,17,21,0.18)",
            line: "rgba(15,17,21,0.08)",
            selectionStroke: designTokens.light.accent,
            selectionFill: "rgba(65,118,230,0.08)",
        },
        node: {
            label: designTokens.light.labelSecondary,
            fill: designTokens.light.bgLayer1,
            panel: designTokens.light.bgSidebar,
            stroke: designTokens.light.borderL2,
            activeStroke: designTokens.light.accent,
            placeholder: designTokens.light.labelTertiary,
            text: designTokens.light.labelPrimary,
            muted: designTokens.light.labelSecondary,
            faint: designTokens.light.labelFaint,
        },
        toolbar: {
            panel: "rgba(255,255,255,0.96)",
            border: designTokens.light.borderL2,
            item: designTokens.light.labelSecondary,
            itemHover: designTokens.light.bgHoverSolid,
            activeBg: designTokens.light.bgOverlay,
            activeText: designTokens.light.labelPrimary,
        },
        state: {
            accent: designTokens.light.accent,
            onAccent: designTokens.light.onBrand,
            success: designTokens.light.success,
            warning: designTokens.light.warning,
            danger: designTokens.light.danger,
            info: designTokens.light.link,
            warningFill: "rgba(245,158,11,0.08)",
            warningBorder: "rgba(245,158,11,0.34)",
            dangerFill: "rgba(236,19,19,0.06)",
            dangerBorder: "rgba(236,19,19,0.32)",
            successFill: "rgba(34,197,94,0.08)",
            successBorder: "rgba(34,197,94,0.30)",
        },
        shadow: {
            panel: `0 18px 54px ${designTokens.light.shadow}`,
            floating: `0 8px 28px ${designTokens.light.shadow}`,
            strong: `0 18px 50px ${designTokens.light.shadowStrong}`,
        },
        role: roleColors,
    },
    dark: {
        canvas: {
            background: designTokens.dark.bgCanvas,
            dot: "rgba(249,250,251,0.20)",
            line: "rgba(249,250,251,0.08)",
            selectionStroke: designTokens.dark.accent,
            selectionFill: "rgba(122,170,255,0.12)",
        },
        node: {
            label: designTokens.dark.labelSecondary,
            fill: designTokens.dark.bgLayer1,
            panel: designTokens.dark.bgSidebar,
            stroke: designTokens.dark.borderL2,
            activeStroke: designTokens.dark.accent,
            placeholder: designTokens.dark.labelTertiary,
            text: designTokens.dark.labelPrimary,
            muted: designTokens.dark.labelSecondary,
            faint: designTokens.dark.labelFaint,
        },
        toolbar: {
            panel: "rgba(35,35,36,0.96)",
            border: designTokens.dark.borderL2,
            item: designTokens.dark.labelSecondary,
            itemHover: designTokens.dark.bgLayer2,
            activeBg: designTokens.dark.bgLayer3,
            activeText: designTokens.dark.labelPrimary,
        },
        state: {
            accent: designTokens.dark.accent,
            onAccent: designTokens.dark.onBrand,
            success: designTokens.dark.success,
            warning: designTokens.dark.warning,
            danger: designTokens.dark.danger,
            info: designTokens.dark.link,
            warningFill: "rgba(247,173,49,0.10)",
            warningBorder: "rgba(247,173,49,0.36)",
            dangerFill: "rgba(242,90,90,0.10)",
            dangerBorder: "rgba(242,90,90,0.36)",
            successFill: "rgba(34,197,94,0.10)",
            successBorder: "rgba(34,197,94,0.32)",
        },
        shadow: {
            panel: `0 18px 54px ${designTokens.dark.shadow}`,
            floating: `0 8px 28px ${designTokens.dark.shadow}`,
            strong: `0 18px 50px ${designTokens.dark.shadowStrong}`,
        },
        role: roleColors,
    },
} as const;

export type CanvasTheme = (typeof canvasThemes)[CanvasColorTheme];
