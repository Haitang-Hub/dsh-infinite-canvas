import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

import { designTokens } from "./design-tokens";

/**
 * antd 令牌对齐 DSH 设计令牌：
 *   - colorPrimary 用品牌中性色（DSH 的 brand-primary 本身就是近黑/近白，不是蓝）
 *   - colorInfo / colorLink 用品牌蓝（state-business-primary）
 *   - 悬浮/选中态用 DSH 的 interactive-bg-hover / active
 */
const neutral = {
    light: {
        primary: designTokens.light.brand,
        primaryHover: designTokens.light.brandHover,
        primaryText: designTokens.light.onBrand,
        elevatedBg: designTokens.light.bgLayer1,
        itemHoverBg: designTokens.light.bgHover,
        itemSelectedBg: designTokens.light.bgActive,
        itemSelectedHoverBg: "rgba(38,49,72,0.14)",
        itemText: designTokens.light.labelPrimary,
        tableSelectedBg: designTokens.light.bgHover,
        tableSelectedHoverBg: designTokens.light.bgActive,
        info: designTokens.light.accent,
        link: designTokens.light.link,
    },
    dark: {
        primary: designTokens.dark.brand,
        primaryHover: designTokens.dark.brandHover,
        primaryText: designTokens.dark.onBrand,
        elevatedBg: designTokens.dark.bgLayer2,
        itemHoverBg: designTokens.dark.bgHover,
        itemSelectedBg: designTokens.dark.bgActive,
        itemSelectedHoverBg: "rgba(255,255,255,0.18)",
        itemText: designTokens.dark.labelPrimary,
        tableSelectedBg: designTokens.dark.bgHover,
        tableSelectedHoverBg: designTokens.dark.bgActive,
        info: designTokens.dark.accent,
        link: designTokens.dark.link,
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            colorPrimary: color.primary,
            colorInfo: color.info,
            colorLink: color.link,
            colorLinkHover: color.info,
            colorLinkActive: color.info,
            colorTextLightSolid: color.primaryText,
            colorBgElevated: color.elevatedBg,
            controlItemBgHover: color.itemHoverBg,
            controlItemBgActive: color.itemSelectedBg,
            controlItemBgActiveHover: color.itemSelectedHoverBg,
        },
        components: {
            Button: {
                primaryShadow: "none",
            },
            Dropdown: {
                colorBgElevated: color.elevatedBg,
                colorText: color.itemText,
                controlItemBgHover: color.itemHoverBg,
                controlItemBgActive: color.itemSelectedBg,
                controlItemBgActiveHover: color.itemSelectedHoverBg,
            },
            Menu: {
                popupBg: color.elevatedBg,
                itemActiveBg: color.itemSelectedBg,
                itemHoverBg: color.itemHoverBg,
                itemSelectedBg: color.itemSelectedBg,
                itemSelectedColor: color.itemText,
                darkPopupBg: neutral.dark.elevatedBg,
                darkItemHoverBg: neutral.dark.itemHoverBg,
                darkItemSelectedBg: neutral.dark.itemSelectedBg,
                darkItemSelectedColor: neutral.dark.itemText,
            },
            Select: {
                optionActiveBg: color.itemHoverBg,
                optionSelectedBg: color.itemSelectedBg,
                optionSelectedColor: color.itemText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}
