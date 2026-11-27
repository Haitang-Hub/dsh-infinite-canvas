import type { CSSProperties } from "react";
import { Tooltip } from "antd";
import { Bot, Keyboard, Puzzle, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAgentStore } from "@/stores/use-agent-store";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

/** 工具栏图标提示统一用 antd Tooltip（深色气泡，跟随主题），不再用原生 title 白框。 */
const TOOLBAR_TOOLTIP_DELAY = 0.2;

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {variant === "canvas" ? <AiAssistantToggle iconStyle={iconStyle} /> : null}
            {onOpenPlugins ? (
                <Tooltip title={t("topNav.plugins")} mouseEnterDelay={TOOLBAR_TOOLTIP_DELAY}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")}>
                        <Puzzle className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
            {showConfig ? (
                <Tooltip title={t("navigation.config")} mouseEnterDelay={TOOLBAR_TOOLTIP_DELAY}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")}>
                        <Settings2 className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
            <Tooltip title={languageLabel} mouseEnterDelay={TOOLBAR_TOOLTIP_DELAY}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <Tooltip title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} mouseEnterDelay={TOOLBAR_TOOLTIP_DELAY}>
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
            </Tooltip>
            {onOpenShortcuts ? (
                <Tooltip title={t("topNav.shortcuts")} mouseEnterDelay={TOOLBAR_TOOLTIP_DELAY}>
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")}>
                        <Keyboard className="size-4" />
                    </button>
                </Tooltip>
            ) : null}
        </div>
    );
}

/** 「Agent」开关按钮（图标 + 文字，对齐 Canvas Director 顶栏开关）：面板开启时高亮，点击切换关闭/打开。 */
function AiAssistantToggle({ iconStyle }: { iconStyle: CSSProperties | undefined }) {
    const { t } = useTranslation();
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    return (
        <button
            type="button"
            className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${panelOpen ? "bg-[var(--dsw-alias-interactive-bg-active)]" : "hover:bg-accent"}`}
            style={iconStyle}
            aria-label={t("aiAssistant.title")}
            aria-pressed={panelOpen}
            onClick={togglePanel}
        >
            <Bot className="size-4" />
            <span className="hidden sm:inline">{t("aiAssistant.title")}</span>
        </button>
    );
}
