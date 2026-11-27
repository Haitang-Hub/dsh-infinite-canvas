/**
 * infinite-canvas 的唯一主题色板（对齐 DSH design-platform 设计令牌）。
 *
 * 取值来源：@deepseek-ai/dsh-client-ui-theme 的 design-platform.css
 *   - 静态调色板：neutral-bluish（冷调中性灰）、deepseek（品牌蓝）、green / amber / red / violet / blue
 *   - 语义别名：bg-base / bg-layer-1..3 / label-primary|secondary|tertiary、border-l1..l4、
 *     interactive-bg-hover|active、state-business-primary、state-success/error、link
 *
 * 约定：组件不再写死十六进制色值。JS 里取 `canvasThemes[light|dark]`，
 * CSS / className 里取 `var(--dsw-alias-*)`（globals.css 里有同名变量定义）。
 */

export const palette = {
  neutralBluish00: "#ffffff",
  neutralBluish50: "#f9fafb",
  neutralBluish55: "#f5f7fa",
  neutralBluish60: "#f9fafb",
  neutralBluish75: "#f1f3f5",
  neutralBluish90: "#edf0f4",
  neutralBluish100: "#ebedf2",
  neutralBluish150: "#e9ecf2",
  neutralBluish200: "#e1e5ee",
  neutralBluish300: "#cfd3d6",
  neutralBluish400: "#adb2b8",
  neutralBluish500: "#979da6",
  neutralBluish600: "#81858c",
  neutralBluish700: "#61666b",
  neutralBluish750: "#43454a",
  neutralBluish800: "#353536",
  neutralBluish850: "#2c2c2e",
  neutralBluish875: "#232324",
  neutralBluish900: "#1b1b1c",
  neutralBluish950: "#151517",
  neutralBluish1000: "#0f1115",

  deepseek400: "#7aaaff",
  deepseek450: "#5686fe",
  deepseek500: "#4176e6",
  deepseek600: "#4868b2",
  deepseek800: "#34415b",
  deepseek100: "#e4edfd",

  green400: "#4ed17e",
  green500: "#22c55e",

  amber400: "#f7ad31",
  amber500: "#f59e0b",

  red400: "#f25a5a",
  red600: "#ec1313",

  violet400: "#a78bfa",
  violet600: "#7c3aed",

  blue450: "#4d93f8",
  blue500: "#3b82f6",
} as const;

/** 语义令牌：浅色 / 深色两态，值即 DSH 对应 alias 的最终颜色。 */
export const designTokens = {
  light: {
    bgBase: palette.neutralBluish00,
    bgCanvas: palette.neutralBluish55,
    bgLayer1: palette.neutralBluish00,
    bgLayer2: palette.neutralBluish00,
    bgLayer3: palette.neutralBluish00,
    bgSidebar: palette.neutralBluish50,
    bgOverlay: palette.neutralBluish150,
    bgHover: "rgba(38,49,72,0.06)",
    bgActive: "rgba(38,49,72,0.10)",
    bgHoverSolid: palette.neutralBluish75,

    labelPrimary: palette.neutralBluish1000,
    labelSecondary: palette.neutralBluish700,
    labelTertiary: palette.neutralBluish600,
    labelFaint: palette.neutralBluish400,
    labelDimmed: palette.neutralBluish200,

    borderL1: "rgba(0,0,0,0.04)",
    borderL2: "rgba(0,0,0,0.10)",
    borderL3: "rgba(0,0,0,0.12)",
    borderL4: "rgba(0,0,0,0.16)",

    brand: palette.neutralBluish1000,
    brandHover: palette.neutralBluish750,
    onBrand: palette.neutralBluish00,

    accent: palette.deepseek500,
    accentHover: palette.deepseek400,
    link: palette.deepseek500,

    success: palette.green500,
    successSecondary: palette.green400,
    warning: palette.amber500,
    warningSecondary: palette.amber400,
    danger: palette.red600,
    dangerSecondary: palette.red400,

    shadow: "rgba(15,17,21,0.12)",
    shadowStrong: "rgba(15,17,21,0.18)",
  },
  dark: {
    bgBase: palette.neutralBluish950,
    bgCanvas: palette.neutralBluish950,
    bgLayer1: palette.neutralBluish875,
    bgLayer2: palette.neutralBluish850,
    bgLayer3: palette.neutralBluish800,
    bgSidebar: palette.neutralBluish900,
    bgOverlay: palette.neutralBluish700,
    bgHover: "rgba(255,255,255,0.08)",
    bgActive: "rgba(255,255,255,0.14)",
    bgHoverSolid: palette.neutralBluish800,

    labelPrimary: palette.neutralBluish50,
    labelSecondary: palette.neutralBluish300,
    labelTertiary: palette.neutralBluish400,
    labelFaint: palette.neutralBluish500,
    labelDimmed: palette.neutralBluish750,

    borderL1: "rgba(255,255,255,0.06)",
    borderL2: "rgba(255,255,255,0.12)",
    borderL3: "rgba(255,255,255,0.16)",
    borderL4: "rgba(255,255,255,0.20)",

    brand: palette.neutralBluish50,
    brandHover: palette.neutralBluish100,
    onBrand: palette.neutralBluish1000,

    accent: palette.deepseek400,
    accentHover: palette.deepseek500,
    link: palette.deepseek400,

    success: palette.green500,
    successSecondary: palette.green400,
    warning: palette.amber400,
    warningSecondary: palette.amber500,
    danger: palette.red400,
    dangerSecondary: palette.red400,

    shadow: "rgba(0,0,0,0.36)",
    shadowStrong: "rgba(0,0,0,0.5)",
  },
} as const;

/** 资产/节点类型的标识色：同一套静态调色板，浅深两态共用。 */
export const roleColors = {
  image: palette.green500,
  video: palette.amber500,
  audio: palette.violet400,
  config: palette.deepseek500,
  group: palette.neutralBluish400,
  director: palette.violet600,
  shot: palette.amber400,
} as const;

export type DesignTokens = (typeof designTokens)["light"];
