import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Popover, Select, Slider, Switch, Tooltip } from "antd";
import { ArrowUp, Bot, ChevronDown, Eraser, SlidersHorizontal, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { requestImageQuestion } from "@/services/api/image";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useBridgeStore } from "@/stores/use-bridge-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAiAssistantStore, type AssistantMessage } from "@/stores/use-ai-assistant-store";
import { ASSISTANT_TOOL_ROUND_LIMIT, buildAssistantSystemPrompt, parseAssistantToolCall, runAssistantTool, toAssistantAiMessages, visibleAssistantText } from "@/lib/agent/ai-assistant-engine";
import { clampPanel, dockSideFromPanel, magnetizeFab, type DockSide } from "@/lib/agent/assistant-magnet";
import { randomId } from "@/lib/utils";

const MIN_W = 320;
const MIN_H = 360;
const FAB_SIZE = 52;
/** 输入框自适应高度上限（px），超过后内部滚动。 */
const INPUT_MAX_HEIGHT = 200;

/**
 * AI 助手：可悬浮、拖动、整边停靠的对话面板。
 * - 拖动自由移动；指针压入屏幕左/右/底边缘内松手 → 整边停靠（左/右全高侧栏、底部全宽，完全贴合）
 * - 停靠态按住标题栏即可拖出恢复悬浮
 * - 最小化为可拖动悬浮球（带左右磁吸）
 * - 底部为圆角卡片式输入区：自适应高度 + 内嵌模型选择/外观/清空 + 圆形发送键
 * - 外观（毛玻璃/紧凑）与几何状态持久化；配色取自画布主题 token
 */
export function AiAssistant() {
    const geometry = useAiAssistantStore((state) => state.geometry);

    if (geometry.mode === "minimized") return <AssistantFab />;
    return (
        <AssistantWindow key={geometry.mode === "float" ? "float" : "docked"}>
            <AssistantHeader />
            <AssistantChat />
        </AssistantWindow>
    );
}

/** 面板窗体：主题变量注入；停靠态按边贴合视口（直角、只留内边界），悬浮态圆角自由定位。 */
function AssistantWindow({ children }: { children: React.ReactNode }) {
    const dark = useThemeStore((state) => state.theme) === "dark";
    const theme = canvasThemes[dark ? "dark" : "light"];
    const geometry = useAiAssistantStore((state) => state.geometry);
    const style = useAiAssistantStore((state) => state.style);
    const dockHint = useAiAssistantStore((state) => state.dockHint);
    const docked = geometry.mode !== "float";

    const position: React.CSSProperties = geometry.mode === "left"
        ? { top: 0, bottom: 0, left: 0, width: geometry.w }
        : geometry.mode === "right"
            ? { top: 0, bottom: 0, right: 0, width: geometry.w }
            : geometry.mode === "bottom"
                ? { left: 0, right: 0, bottom: 0, height: geometry.h }
                : { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h };
    const windowStyle = {
        ...position,
        ...themeVars(theme, dark, style),
    } as React.CSSProperties;
    const borderSide = geometry.mode === "left" ? { borderRightWidth: 1 } : geometry.mode === "right" ? { borderLeftWidth: 1 } : { borderTopWidth: 1 };

    return (
        <div
            className={`ai-assistant fixed z-[95] flex flex-col overflow-hidden border ${docked ? "rounded-none border-y-0 border-x-0" : "rounded-2xl"}`}
            style={{ ...windowStyle, ...(docked ? borderSide : {}) }}
        >
            {children}
            {docked ? <DockEdge mode={geometry.mode as "left" | "right" | "bottom"} /> : <ResizeCorner />}
            <DockHintOverlay hint={dockHint} />
        </div>
    );
}

/** 拖动中面板贴边的停靠预览遮罩。 */
function DockHintOverlay({ hint }: { hint: "left" | "right" | "bottom" | null }) {
    const { t } = useTranslation();
    if (!hint) return null;
    return (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-stone-950/45 backdrop-blur-[2px]">
            <span className="rounded-full bg-stone-900/85 px-4 py-1.5 text-sm font-medium text-white shadow-lg">
                {t(hint === "left" ? "aiAssistant.dockLeft" : hint === "right" ? "aiAssistant.dockRight" : "aiAssistant.dockBottom")}
            </span>
        </div>
    );
}

/** 画布主题 token + 外观偏好 → CSS 变量集合；强调色直接跟随应用主题主色（单色系）。 */
function themeVars(theme: (typeof canvasThemes)[keyof typeof canvasThemes], dark: boolean, style: { glass: number }) {
    return {
        "--ai-bg": theme.toolbar.panel,
        "--ai-soft": theme.node.fill,
        "--ai-border": theme.toolbar.border,
        "--ai-text": theme.node.text,
        "--ai-muted": theme.node.faint,
        "--ai-hover": theme.toolbar.itemHover,
        "--ai-accent": dark ? "#fafafa" : "#171717",
        "--ai-accent-text": dark ? "#171717" : "#fafafa",
        "--ai-glass": style.glass,
    } as React.CSSProperties;
}

/** 标题栏：拖动（自由移动）+ 面板贴边显示停靠预览、松手停靠 + 唯一的关闭（最小化为悬浮球）按钮。 */
function AssistantHeader() {
    const { t } = useTranslation();
    const geometry = useAiAssistantStore((state) => state.geometry);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const setDockHint = useAiAssistantStore((state) => state.setDockHint);
    const minimize = useAiAssistantStore((state) => state.minimize);
    const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean; undockSide: DockSide | null; hint: DockSide | null } | null>(null);

    const onPointerDown = (event: React.PointerEvent) => {
        if ((event.target as HTMLElement).closest("button")) return;
        const panel = (event.currentTarget as HTMLElement).closest(".ai-assistant") as HTMLElement | null;
        const rect = panel?.getBoundingClientRect();
        const originX = rect?.x ?? geometry.x;
        const originY = rect?.y ?? geometry.y;
        // 停靠态不立即切悬浮：等真正拖动超过阈值才带悬浮尺寸拖出，避免单击导致面板缩水。
        drag.current = { startX: event.clientX, startY: event.clientY, originX, originY, moved: false, undockSide: null, hint: null };
        const onMove = (moveEvent: PointerEvent) => {
            const state = drag.current;
            if (!state) return;
            const dx = moveEvent.clientX - state.startX;
            const dy = moveEvent.clientY - state.startY;
            if (!state.moved && Math.abs(dx) + Math.abs(dy) <= 4) return;
            state.moved = true;
            // 记录本次手势拖出的停靠侧：该侧本次松手不再回吸，拖到别的边仍可停靠。
            if (!state.undockSide && useAiAssistantStore.getState().geometry.mode !== "float") {
                state.undockSide = useAiAssistantStore.getState().geometry.mode as DockSide;
                // 拖出后恢复悬浮尺寸（w/h 保存的是最近一次悬浮/用户调整值），高度不超过 85% 视口；
                // 不能沿用停靠态视觉尺寸（底停靠全宽、侧停靠全高），否则悬浮后 x/y 全被夹死导致面板拖不动。
                const g = useAiAssistantStore.getState().geometry;
                setGeometry({
                    mode: "float",
                    x: state.originX,
                    y: state.originY,
                    w: g.w,
                    h: Math.min(g.h, Math.round(window.innerHeight * 0.85)),
                });
            }
            const g2 = useAiAssistantStore.getState().geometry;
            const pos = clampPanel(state.originX + dx, state.originY + dy, g2.w, g2.h);
            setGeometry(pos);
            // 停靠预览按面板自身位置判定：面板贴到某边即显示预览（光标无需触及屏幕边缘）。
            const hint = dockSideFromPanel(pos.x, pos.y, g2.w, g2.h, state.undockSide);
            state.hint = hint;
            setDockHint(hint);
        };
        const onUp = () => {
            const state = drag.current;
            drag.current = null;
            // 松手时面板正贴着某边（预览中）→ 停靠到该边。
            if (state?.moved && state.hint) {
                const currentH = useAiAssistantStore.getState().geometry.h;
                if (state.hint === "bottom") setGeometry({ mode: "bottom", h: Math.min(currentH, 420) });
                else setGeometry({ mode: state.hint });
            }
            setDockHint(null);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div
            className="flex h-11 shrink-0 cursor-grab select-none items-center gap-2 border-b px-3 active:cursor-grabbing"
            style={{ borderColor: "var(--ai-border)" }}
            onPointerDown={onPointerDown}
        >
            <span className="ai-accent grid size-6 shrink-0 place-items-center rounded-lg shadow-sm" style={{ color: "var(--ai-accent-text)" }}>
                <Bot className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: "var(--ai-text)" }}>{t("aiAssistant.title")}</span>
            <Tooltip title={t("aiAssistant.minimize")}>
                <button
                    type="button"
                    className="grid size-7 shrink-0 place-items-center rounded-md transition hover:bg-[var(--ai-hover)]"
                    style={{ color: "var(--ai-muted)" }}
                    aria-label={t("aiAssistant.minimize")}
                    onClick={minimize}
                >
                    <X className="size-4" />
                </button>
            </Tooltip>
        </div>
    );
}

/** 外观设置：毛玻璃 / 紧凑模式（从标题栏移入输入区）。 */
function AssistantStyleSettings() {
    const { t } = useTranslation();
    const style = useAiAssistantStore((state) => state.style);
    const setStyle = useAiAssistantStore((state) => state.setStyle);
    return (
        <div className="space-y-4 text-xs">
            <div>
                <div className="mb-1 font-medium">{t("aiAssistant.glass")}</div>
                <Slider min={0} max={90} value={style.glass} onChange={(value) => setStyle({ glass: value as number })} tooltip={{ formatter: (value) => `${value}%` }} className="!my-1" />
            </div>
            <div className="flex items-center justify-between">
                <span className="font-medium">{t("aiAssistant.compact")}</span>
                <Switch size="small" checked={style.compact} onChange={(checked) => setStyle({ compact: checked })} />
            </div>
        </div>
    );
}

/** 悬浮球：可拖动 + 左右磁吸 + 点击展开。 */
function AssistantFab() {
    const { t } = useTranslation();
    const dark = useThemeStore((state) => state.theme) === "dark";
    const theme = canvasThemes[dark ? "dark" : "light"];
    const geometry = useAiAssistantStore((state) => state.geometry);
    const style = useAiAssistantStore((state) => state.style);
    const busy = useAiAssistantStore((state) => state.busy);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const open = useAiAssistantStore((state) => state.open);
    const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const defaulted = !geometry.fabX && !geometry.fabY;
    const position = defaulted
        ? { right: 24, bottom: 24 }
        : { left: geometry.fabX, top: geometry.fabY };

    const onPointerDown = (event: React.PointerEvent) => {
        drag.current = { startX: event.clientX, startY: event.clientY, originX: defaulted ? window.innerWidth - FAB_SIZE - 24 : geometry.fabX, originY: defaulted ? window.innerHeight - FAB_SIZE - 24 : geometry.fabY, moved: false };
        // 窗口级监听而非 pointer capture：对真实与合成输入都稳定。
        const onMove = (moveEvent: PointerEvent) => {
            const state = drag.current;
            if (!state) return;
            if (Math.abs(moveEvent.clientX - state.startX) + Math.abs(moveEvent.clientY - state.startY) > 4) state.moved = true;
            if (!state.moved) return;
            const magnet = magnetizeFab(state.originX + moveEvent.clientX - state.startX, state.originY + moveEvent.clientY - state.startY, FAB_SIZE);
            setGeometry({ fabX: magnet.x, fabY: magnet.y });
        };
        const onUp = () => {
            const moved = drag.current?.moved;
            drag.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            if (!moved) open("float");
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <button
            type="button"
            className={`ai-accent fixed z-[95] grid place-items-center rounded-full shadow-lg transition-transform hover:scale-110 active:scale-95 ${busy ? "animate-pulse" : ""}`}
            style={{ ...position, width: FAB_SIZE, height: FAB_SIZE, color: "var(--ai-accent-text)", ...themeVars(theme, dark, style) }}
            onPointerDown={onPointerDown}
            aria-label={t("aiAssistant.open")}
            title={t("aiAssistant.open")}
        >
            <Bot className="size-6" />
        </button>
    );
}

/** 停靠态内边缘拖动调尺寸：左/右停靠调宽度，底部停靠调高度（窗口级监听，合成输入同样可用）。 */
function DockEdge({ mode }: { mode: "left" | "right" | "bottom" }) {
    const geometry = useAiAssistantStore((state) => state.geometry);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const horizontal = mode === "bottom";
    const edgeStyle: React.CSSProperties = horizontal
        ? { top: 0, left: 0, right: 0, height: 6, cursor: "ns-resize" }
        : mode === "left"
            ? { top: 0, bottom: 0, right: 0, width: 6, cursor: "ew-resize" }
            : { top: 0, bottom: 0, left: 0, width: 6, cursor: "ew-resize" };
    return (
        <span
            className="absolute z-10"
            style={edgeStyle}
            onPointerDown={(event) => {
                event.preventDefault();
                document.body.style.userSelect = "none";
                const start = horizontal ? event.clientY : event.clientX;
                const startSize = horizontal ? geometry.h : geometry.w;
                const onMove = (moveEvent: PointerEvent) => {
                    const delta = (horizontal ? moveEvent.clientY : moveEvent.clientX) - start;
                    // 左停靠向右增宽；右停靠向左增宽；底部向上增高。
                    const size = mode === "left" ? startSize + delta : startSize - delta;
                    if (horizontal) setGeometry({ h: Math.min(Math.max(200, size), Math.floor(window.innerHeight * 0.7)) });
                    else setGeometry({ w: Math.min(Math.max(280, size), Math.min(Math.floor(window.innerWidth * 0.7), 720)) });
                };
                const onUp = () => {
                    document.body.style.userSelect = "";
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
            }}
            aria-hidden
        />
    );
}

/** 悬浮态右下角尺寸手柄。 */
function ResizeCorner() {
    const geometry = useAiAssistantStore((state) => state.geometry);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const drag = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null);
    return (
        <span
            className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
            onPointerDown={(event) => {
                event.preventDefault();
                document.body.style.userSelect = "none";
                drag.current = { startX: event.clientX, startY: event.clientY, w: geometry.w, h: geometry.h };
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                const state = drag.current;
                if (!state) return;
                setGeometry({
                    w: Math.min(Math.max(MIN_W, state.w + event.clientX - state.startX), window.innerWidth - geometry.x - 8),
                    h: Math.min(Math.max(MIN_H, state.h + event.clientY - state.startY), window.innerHeight - geometry.y - 8),
                });
            }}
            onPointerUp={() => {
                drag.current = null;
                document.body.style.userSelect = "";
            }}
            aria-hidden
        >
            <svg viewBox="0 0 16 16" className="size-full" style={{ color: "var(--ai-muted)" }}><path d="M14 6 6 14M14 11l-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </span>
    );
}

/** 输入区：圆角卡片式 composer。自适应高度输入框 + 底部内嵌工具栏（模型/外观/清空 + 圆形发送键）。 */
function InputBar({ draft, setDraft, streaming, messages, onSend, onStop, onClear }: {
    draft: string;
    setDraft: (value: string) => void;
    streaming: boolean;
    messages: AssistantMessage[];
    onSend: () => void;
    onStop: () => void;
    onClear: () => void;
}) {
    const { t } = useTranslation();
    const setStyle = useAiAssistantStore((state) => state.setStyle);
    const selectedModel = useAiAssistantStore((state) => state.style.model);
    const config = useConfigStore((state) => state.config);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const modelOptions = useMemo(() => selectableModelsByCapability(config, "text").map((value) => ({
        value,
        label: modelOptionLabel(config, value) || value,
    })), [config]);
    const activeModel = selectedModel || config.model || config.textModel;

    // 自适应高度：随内容增长，超过上限后内部滚动。
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
    }, [draft]);

    const iconButton = "grid size-7 shrink-0 place-items-center rounded-lg transition hover:bg-[var(--ai-hover)] disabled:pointer-events-none disabled:opacity-35";

    return (
        <div className="shrink-0 px-2.5 pb-2.5">
            <div
                className="ai-composer rounded-2xl border transition focus-within:border-[var(--ai-accent)]"
                style={{ borderColor: "var(--ai-border)" }}
            >
                <textarea
                    ref={textareaRef}
                    rows={1}
                    className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed outline-none"
                    style={{ color: "var(--ai-text)", maxHeight: INPUT_MAX_HEIGHT }}
                    value={draft}
                    placeholder={t("aiAssistant.placeholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            onSend();
                        }
                    }}
                />
                <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                    <Select
                        size="small"
                        variant="borderless"
                        showSearch
                        optionFilterProp="label"
                        value={activeModel || undefined}
                        placeholder={t("aiAssistant.modelPlaceholder")}
                        options={modelOptions}
                        onChange={(value) => setStyle({ model: value ?? "" })}
                        popupMatchSelectWidth={false}
                        className="ai-model-select min-w-0 flex-1 !text-xs"
                        aria-label={t("aiAssistant.model")}
                    />
                    <Popover trigger="click" placement="topLeft" arrow={false} overlayStyle={{ minWidth: 248 }} content={<div className="p-3"><AssistantStyleSettings /></div>}>
                        <Tooltip title={t("aiAssistant.styleSettings")}>
                            <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.styleSettings")}>
                                <SlidersHorizontal className="size-3.5" />
                            </button>
                        </Tooltip>
                    </Popover>
                    <Tooltip title={t("aiAssistant.clear")}>
                        <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} onClick={onClear} disabled={!messages.length || streaming} aria-label={t("aiAssistant.clear")}>
                            <Eraser className="size-3.5" />
                        </button>
                    </Tooltip>
                    <div className="min-w-2 flex-1" />
                    {streaming ? (
                        <Tooltip title={t("aiAssistant.stop")}>
                            <button
                                type="button"
                                className="grid size-8 shrink-0 place-items-center rounded-full border shadow-sm transition hover:brightness-110 active:scale-95"
                                style={{ borderColor: "var(--ai-border)", color: "var(--ai-text)" }}
                                onClick={onStop}
                                aria-label={t("aiAssistant.stop")}
                            >
                                <Square className="size-3 fill-current" />
                            </button>
                        </Tooltip>
                    ) : (
                        <Tooltip title={t("aiAssistant.send")}>
                            <button
                                type="button"
                                className="ai-accent grid size-8 shrink-0 place-items-center rounded-full shadow-sm transition hover:brightness-110 active:scale-95 disabled:opacity-40"
                                style={{ color: "var(--ai-accent-text)" }}
                                disabled={!draft.trim()}
                                onClick={onSend}
                                aria-label={t("aiAssistant.send")}
                            >
                                <ArrowUp className="size-4" strokeWidth={2.5} />
                            </button>
                        </Tooltip>
                    )}
                </div>
            </div>
        </div>
    );
}

/** 对话区：流式消息 + 工具卡片 + 输入框 + 工具循环。 */
function AssistantChat() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message: toast } = App.useApp();
    const compact = useAiAssistantStore((state) => state.style.compact);
    const messages = useAiAssistantStore((state) => state.messages);
    const streaming = useAiAssistantStore((state) => state.streaming);
    const addMessage = useAiAssistantStore((state) => state.addMessage);
    const patchMessage = useAiAssistantStore((state) => state.patchMessage);
    const setStreaming = useAiAssistantStore((state) => state.setStreaming);
    const setBusy = useAiAssistantStore((state) => state.setBusy);
    const clearMessages = useAiAssistantStore((state) => state.clearMessages);
    const [draft, setDraft] = useState("");
    const listRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [messages]);

    const toolContext = useMemo(() => ({
        canvasSnapshot: useBridgeStore.getState().canvasContext?.snapshot || null,
        applyOps: (ops: unknown[]) => {
            const context = useBridgeStore.getState().canvasContext;
            if (!context) throw new Error(t("aiAssistant.noCanvas"));
            return context.applyOps(ops as never);
        },
        navigate,
    }), [navigate, t]);

    const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || streaming) return;
        setDraft("");
        addMessage({ id: randomId(), role: "user", text });
        setStreaming(true);
        setBusy(true);
        abortRef.current = new AbortController();
        try {
            // 助手选定了模型时覆盖全局配置;空串跟随全局。
            const globalConfig = useConfigStore.getState().config;
            const chosenModel = useAiAssistantStore.getState().style.model;
            const config = chosenModel ? { ...globalConfig, model: chosenModel } : globalConfig;
            for (let round = 1; round <= ASSISTANT_TOOL_ROUND_LIMIT; round += 1) {
                const systemPrompt = buildAssistantSystemPrompt({ canvasSnapshot: useBridgeStore.getState().canvasContext?.snapshot || null, applyOps: toolContext.applyOps, navigate });
                const assistantId = randomId();
                addMessage({ id: assistantId, role: "assistant", text: "" });
                let last = "";
                const answer = await requestImageQuestion(
                    config,
                    toAssistantAiMessages(systemPrompt, useAiAssistantStore.getState().messages.filter((item) => item.id !== assistantId)),
                    (delta) => {
                        last = delta;
                        patchMessage(assistantId, { text: delta });
                    },
                    { signal: abortRef.current?.signal },
                );
                patchMessage(assistantId, { text: answer || last });
                const toolCall = parseAssistantToolCall(answer || last);
                if (!toolCall) break;
                const toolMessage: AssistantMessage = { id: randomId(), role: "tool", tool: toolCall.name, input: toolCall.input, round };
                addMessage(toolMessage);
                try {
                    patchMessage(toolMessage.id, { result: await runAssistantTool(toolCall, toolContext) });
                } catch (error) {
                    patchMessage(toolMessage.id, { error: error instanceof Error ? error.message : String(error) });
                }
            }
            // 循环耗尽且最后一步仍是工具执行（任务没做完）：给出明确反馈，用户可发「继续」接着处理。
            const tail = useAiAssistantStore.getState().messages.at(-1);
            if (tail?.role === "tool") {
                addMessage({ id: randomId(), role: "notice", text: t("aiAssistant.toolRoundNotice", { count: ASSISTANT_TOOL_ROUND_LIMIT }) });
            }
        } catch (error) {
            if ((error as Error).name !== "AbortError") {
                addMessage({ id: randomId(), role: "error", text: error instanceof Error ? error.message : String(error) });
                toast.error(error instanceof Error ? error.message : t("aiAssistant.requestFailed"));
            }
        } finally {
            setStreaming(false);
            setBusy(false);
            abortRef.current = null;
        }
    }, [addMessage, draft, navigate, patchMessage, setBusy, setStreaming, t, toast, toolContext]);

    const bubble = compact ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2.5 text-sm";

    return (
        <>
            <div ref={listRef} className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-3 ${compact ? "py-2" : "py-3"}`}>
                {messages.length === 0 ? (
                    <div className="grid h-full place-items-center px-6 text-center text-xs" style={{ color: "var(--ai-muted)" }}>
                        <div className="space-y-2">
                            <span className="ai-accent mx-auto grid size-10 place-items-center rounded-2xl shadow" style={{ color: "var(--ai-accent-text)" }}>
                                <Bot className="size-5" />
                            </span>
                            <p>{t("aiAssistant.emptyHint")}</p>
                        </div>
                    </div>
                ) : null}
                {messages.map((item) => (
                    <AssistantBubble key={item.id} message={item} bubbleClass={bubble} />
                ))}
            </div>
            <InputBar
                draft={draft}
                setDraft={setDraft}
                streaming={streaming}
                messages={messages}
                onSend={() => void send()}
                onStop={() => abortRef.current?.abort()}
                onClear={clearMessages}
            />
        </>
    );
}

function AssistantBubble({ message, bubbleClass }: { message: AssistantMessage; bubbleClass: string }) {
    const { t } = useTranslation();
    const compact = useAiAssistantStore((state) => state.style.compact);
    const softStyle = { background: "var(--ai-soft)", color: "var(--ai-text)", borderColor: "var(--ai-border)" } as React.CSSProperties;

    if (message.role === "tool") return <ToolCallRow message={message} compact={compact} />;
    if (message.role === "notice") {
        return (
            <div className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "var(--ai-border)", color: "var(--ai-muted)", background: "var(--ai-soft)" }}>
                {message.text}
            </div>
        );
    }
    if (message.role === "error") return <div className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-500">{message.text}</div>;
    if (message.role === "user") {
        return (
            <div className="flex justify-end">
                <div className={`ai-msg-user max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md shadow-sm ${bubbleClass}`}>{message.text}</div>
            </div>
        );
    }
    const visible = visibleAssistantText(message.text);
    // 工具调用轮次的中间回复剥离协议块后为空：不渲染气泡（进度见工具行），仅流式未出字时显示占位。
    if (!visible) {
        if (message.text) return null;
        return (
            <div className="flex justify-start gap-2">
                <span className="ai-accent mt-1 grid size-6 shrink-0 place-items-center rounded-lg shadow-sm" style={{ color: "var(--ai-accent-text)" }}>
                    <Bot className="size-3.5" />
                </span>
                <div className="rounded-2xl rounded-bl-md border shadow-sm" style={{ ...softStyle, background: "var(--ai-bg)" }}>
                    <div className={bubbleClass}>
                        <span className="inline-flex items-center gap-1 py-1">
                            {[0, 1, 2].map((index) => (
                                <span key={index} className="size-1.5 animate-bounce rounded-full" style={{ background: "var(--ai-accent)", animationDelay: `${index * 120}ms` }} />
                            ))}
                        </span>
                    </div>
                </div>
            </div>
        );
    }
    return (
        <div className="flex justify-start gap-2">
            <span className="ai-accent mt-1 grid size-6 shrink-0 place-items-center rounded-lg shadow-sm" style={{ color: "var(--ai-accent-text)" }}>
                <Bot className="size-3.5" />
            </span>
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md border shadow-sm" style={{ ...softStyle, background: "var(--ai-bg)" }}>
                <div className={bubbleClass}>{visible}</div>
            </div>
        </div>
    );
}

/** 工具调用行：默认折叠只显示「工具名 + 状态」进度，点击按需展开入参/结果详情。 */
function ToolCallRow({ message, compact }: { message: Extract<AssistantMessage, { role: "tool" }>; compact: boolean }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const done = message.result !== undefined;
    const failed = Boolean(message.error);
    return (
        <div className="overflow-hidden rounded-xl border" style={{ borderLeft: "3px solid var(--ai-accent)", background: "var(--ai-bg)" }} aria-label={message.tool}>
            <button
                type="button"
                className="flex w-full items-center gap-1.5 py-1.5 pl-2.5 pr-2 text-left transition hover:bg-[var(--ai-hover)]"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
            >
                <span className={`size-1.5 shrink-0 rounded-full ${failed ? "bg-red-500" : done ? "bg-emerald-500" : "animate-pulse"}`} style={failed || done ? undefined : { background: "var(--ai-accent)" }} />
                <span className="truncate font-mono text-xs" style={{ color: "var(--ai-text)" }}>{message.tool}</span>
                {failed ? <span className="text-xs text-red-500">{t("aiAssistant.toolFailed")}</span> : done ? <span className="text-xs text-emerald-500">{t("aiAssistant.toolDone")}</span> : <span className="animate-pulse text-xs" style={{ color: "var(--ai-muted)" }}>{t("aiAssistant.toolRunning")}</span>}
                <span className="ml-auto flex items-center gap-1 text-[10px]" style={{ color: "var(--ai-muted)" }}>
                    {t("aiAssistant.toolDetail")}
                    <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
                </span>
            </button>
            {open ? (
                <pre className={`overflow-y-auto whitespace-pre-wrap break-all border-t px-3 py-2 font-mono ${compact ? "max-h-24 text-[11px]" : "max-h-48 text-xs"}`} style={{ borderColor: "var(--ai-border)", color: "var(--ai-muted)" }}>{JSON.stringify(message.error ?? message.result ?? message.input, null, 2)}</pre>
            ) : null}
        </div>
    );
}

/** 供外部（顶栏徽标等）打开 AI 助手。 */
export function useOpenAiAssistant() {
    const open = useAiAssistantStore((state) => state.open);
    return useCallback(() => open(), [open]);
}
