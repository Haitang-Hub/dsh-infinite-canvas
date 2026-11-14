import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, FolderOpen, Menu, PanelLeftOpen, Plus, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import { Button, Dropdown, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAgentStore } from "@/stores/use-agent-store";

export function CanvasTopBar({
    title,
    titleDraft,
    isTitleEditing,
    onTitleDraftChange,
    onStartTitleEditing,
    onFinishTitleEditing,
    onCancelTitleEditing,
    canUndo,
    canRedo,
    onOpenProjectDirectory,
    onCreateProject,
    onDeleteProject,
    onExportProject,
    onImportImage,
    onImportCanvas,
    onOpenPlugins,
    onUndo,
    onRedo,
}: {
    title: string;
    titleDraft: string;
    isTitleEditing: boolean;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    canUndo: boolean;
    canRedo: boolean;
    onOpenProjectDirectory: () => void;
    onCreateProject: () => void;
    onDeleteProject: () => void;
    onExportProject: () => void;
    onImportImage: () => void;
    onImportCanvas: () => void;
    onOpenPlugins: () => void;
    onUndo: () => void;
    onRedo: () => void;
}) {
    const colorTheme = useThemeStore((state) => state.theme);
    const { t } = useTranslation();
    const theme = canvasThemes[colorTheme];
    const titleRef = useRef<HTMLDivElement>(null);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const sidePanelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const toggleSidePanel = useCanvasSidePanelStore((state) => state.togglePanel);

    useEffect(() => {
        if (!isTitleEditing) return;
        const close = (event: PointerEvent) => {
            if (!titleRef.current?.contains(event.target as Node)) onFinishTitleEditing();
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [isTitleEditing, onFinishTitleEditing]);

    return (
        <>
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-50 flex h-16 items-center justify-between pl-1 pr-4">
                <div className="pointer-events-auto flex min-w-0 items-center gap-2">
                    {sidePanelOpen ? null : (
                        <Tooltip title={t("canvas.expandPanel")}>
                            <button
                                type="button"
                                onClick={toggleSidePanel}
                                aria-label={t("canvas.expandPanel")}
                                className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                                style={{ color: theme.node.text }}
                            >
                                <PanelLeftOpen className="size-4" />
                            </button>
                        </Tooltip>
                    )}
                    <Dropdown
                        trigger={["click"]}
                        menu={{
                            items: [
                                { key: "directory", icon: <FolderOpen className="size-4" />, label: t("canvas.directory.title"), onClick: onOpenProjectDirectory },
                                { type: "divider" },
                                { key: "new", icon: <Plus className="size-4" />, label: t("canvas.create"), onClick: onCreateProject },
                                { key: "delete", danger: true, icon: <Trash2 className="size-4" />, label: t("canvas.deleteCurrent"), onClick: onDeleteProject },
                                { type: "divider" },
                                { key: "import", icon: <Upload className="size-4" />, label: t("canvas.importAsset"), onClick: onImportImage },
                                { key: "importCanvas", icon: <FolderOpen className="size-4" />, label: t("canvas.import"), onClick: onImportCanvas },
                                { key: "export", icon: <Download className="size-4" />, label: t("canvas.exportCurrent"), onClick: onExportProject },
                                { type: "divider" },
                                { key: "undo", disabled: !canUndo, icon: <Undo2 className="size-4" />, label: <MenuLabel text={t("canvas.undo")} shortcut="⌘ Z" />, onClick: onUndo },
                                { key: "redo", disabled: !canRedo, icon: <Redo2 className="size-4" />, label: <MenuLabel text={t("canvas.redo")} shortcut="⌘ ⇧ Z / ⌘ Y" />, onClick: onRedo },
                            ],
                        }}
                    >
                        <button type="button" className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label={t("canvas.openMenu")}>
                            <Menu className="size-4" />
                        </button>
                    </Dropdown>

                    <div ref={titleRef} className="flex min-w-0 items-center gap-2">
                        {isTitleEditing ? (
                            <input
                                autoFocus
                                value={titleDraft}
                                onChange={(event) => onTitleDraftChange(event.target.value)}
                                onBlur={onFinishTitleEditing}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") onFinishTitleEditing();
                                    if (event.key === "Escape") onCancelTitleEditing();
                                }}
                                className="max-w-[280px] bg-transparent p-0 text-left text-lg font-semibold tracking-normal outline-none"
                                style={{ color: theme.node.text }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="flex min-w-0 max-w-[340px] items-baseline gap-1.5 truncate border-b border-dashed border-transparent text-left text-lg font-semibold tracking-normal transition hover:border-current"
                                onDoubleClick={onStartTitleEditing}
                                title={t("canvas.renameHint")}
                            >
                                <span className="truncate">{title}</span>
                            </button>
                        )}
                    </div>
                    <CompactBridgeStatus />
                </div>

                <div className="pointer-events-auto flex items-center gap-1.5">
                    <UserStatusActions variant="canvas" onOpenShortcuts={() => setShortcutsOpen(true)} onOpenPlugins={onOpenPlugins} />
                </div>
            </div>
            <Modal title={t("canvas.shortcuts")} open={shortcutsOpen} onCancel={() => setShortcutsOpen(false)} footer={null} centered>
                <div className="space-y-0.5 border-t pt-3 text-sm" style={{ borderColor: theme.node.stroke }}>
                    <Shortcut keys={["Ctrl / Space", t("canvas.shortcut.drag")]} value={t("canvas.shortcut.toggleTool")} />
                    <Shortcut keys={[t("canvas.shortcut.wheel")]} value={t("canvas.shortcut.zoom")} />
                    <Shortcut keys={[t("canvas.shortcut.zoomSlider")]} value={t("canvas.shortcut.preciseZoom")} />
                    <Shortcut keys={[t("canvas.shortcut.drag")]} value={t("canvas.shortcut.boxSelect")} />
                    <Shortcut keys={["Shift / Cmd", t("canvas.shortcut.click")]} value={t("canvas.shortcut.addSelection")} />
                    <Shortcut keys={["Ctrl / Cmd", "A"]} value={t("canvas.shortcut.selectAll")} />
                    <Shortcut keys={["Ctrl / Cmd", "C / V"]} value={t("canvas.shortcut.copyPaste")} />
                    <Shortcut keys={["Ctrl / Cmd", "G"]} value={t("canvas.shortcut.group")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "G"]} value={t("canvas.shortcut.ungroup")} />
                    <Shortcut keys={["Ctrl / Cmd", "Z"]} value={t("canvas.undo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Shift", "Z"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Ctrl / Cmd", "Y"]} value={t("canvas.redo")} />
                    <Shortcut keys={["Delete / Backspace"]} value={t("canvas.shortcut.delete")} />
                    <Shortcut keys={["Esc"]} value={t("canvas.shortcut.escape")} />
                    <Shortcut keys={[t("canvas.shortcut.dropMedia")]} value={t("canvas.shortcut.upload")} />
                </div>
            </Modal>
        </>
    );
}

function MenuLabel({ text, shortcut }: { text: string; shortcut: string }) {
    return (
        <span className="flex min-w-36 items-center justify-between gap-8">
            <span>{text}</span>
            <span className="text-xs opacity-45">{shortcut}</span>
        </span>
    );
}

/** 顶栏导演台连接指示器：轮询探测 3D 导演台本地桥（127.0.0.1:17372 /health，免 token）
 *  是否安装并启动，在线即显示「导演台已连接」。画布 Agent 桥连接全自动，不再在此展示。 */
function CompactBridgeStatus() {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const { t } = useTranslation();
    const [deskOnline, setDeskOnline] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        const probe = async () => {
            try {
                const res = await fetch("http://127.0.0.1:17372/health", { signal: AbortSignal.timeout(2000) });
                const body = (await res.json().catch(() => null)) as { ok?: boolean; plugin?: string } | null;
                if (!cancelled) setDeskOnline(Boolean(body?.ok && body?.plugin === "director-desk"));
            } catch {
                if (!cancelled) setDeskOnline(false);
            }
        };
        void probe();
        const timer = window.setInterval(probe, 10_000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, []);
    const label = deskOnline === null ? t("canvas.directorChecking") : deskOnline ? t("canvas.directorConnected") : t("canvas.directorDisconnected");
    const online = deskOnline === true;
    return (
        <div className="flex h-8 items-center gap-1.5 text-xs" style={{ color: online ? "#16a34a" : theme.node.muted }} title={label} aria-label={label}>
            <span className={`size-2 shrink-0 rounded-full ${deskOnline === null ? "animate-pulse" : ""}`} style={{ background: online ? "#22c55e" : theme.node.muted }} />
            <span className="hidden max-w-[140px] truncate sm:inline">{label}</span>
        </div>
    );
}

function Shortcut({ keys, value }: { keys: string[]; value: string }) {
    // 键帽随画布主题取色：浅色用暖灰白底、深色用比画布略亮的中性灰底（避免纯白块刺眼），
    // 描边与文字都用主题 node 色，保证明暗两套下对比度与画布整体一致。
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const isDark = colorTheme === "dark";
    const capStyle: CSSProperties = {
        borderColor: theme.node.stroke,
        background: isDark ? "#383431" : "linear-gradient(#fafaf9, rgba(231,229,223,.9))",
        color: theme.node.text,
        boxShadow: isDark ? "inset 0 -1px 0 rgba(0,0,0,.4), 0 1px 1px rgba(0,0,0,.3)" : "inset 0 -1px 0 rgba(0,0,0,.06), 0 1px 1px rgba(0,0,0,.05)",
    };
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-4 rounded-md px-1 py-1">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
                {keys.map((key, index) => (
                    <span key={`${key}-${index}`} className="flex items-center gap-1">
                        {index ? <span className="text-[11px] opacity-30">+</span> : null}
                        <kbd className="min-w-7 rounded border px-1.5 py-0.5 text-center text-[11px] font-medium leading-none" style={capStyle}>
                            {key}
                        </kbd>
                    </span>
                ))}
            </span>
            <span className="text-right text-xs opacity-50">{value}</span>
        </div>
    );
}
