import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Popover, Select, Slider, Switch, Tooltip } from "antd";
import { Bot, ChevronDown, CircleStop, Eraser, Grip, Maximize2, PanelBottom, PanelLeft, PanelRight, Send, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { requestImageQuestion } from "@/services/api/image";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useBridgeStore } from "@/stores/use-bridge-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAiAssistantStore, type AssistantGeometry, type AssistantMessage } from "@/stores/use-ai-assistant-store";
import { ASSISTANT_TOOL_ROUND_LIMIT, buildAssistantSystemPrompt, parseAssistantToolCall, runAssistantTool, toAssistantAiMessages } from "@/lib/agent/ai-assistant-engine";
import { dockIntentFromPointer, magnetizeFab, magnetizePanel } from "@/lib/agent/assistant-magnet";
import { randomId } from "@/lib/utils";

const MIN_W = 320;
const MIN_H = 360;
const FAB_SIZE = 52;

/**
 * AI 助手：可悬浮、拖动、磁性吸附、停靠的对话面板。
 * - 悬浮态自由拖动，靠近屏幕四边/四角自动磁吸贴齐（带回弹过渡动画）
 * - 指针压到屏幕边缘松手可整边停靠（左/右/底），停靠厚度可拖动调节
 * - 最小化为可拖动悬浮球（同样带左右磁吸）
 * - 外观（强调色/毛玻璃/紧凑）与几何状态持久化；配色取自画布主题 token
 */
export function AiAssistant() {
    const { t } = useTranslation();
    const geometry = useAiAssistantStore((state) => state.geometry);
    const [dockHint, setDockHint] = useState<"left" | "right" | "bottom" | null>(null);

    if (geometry.mode === "minimized") return <AssistantFab />;
    return (
        <AssistantWindow dockHint={dockHint} key={geometry.mode}>
            <AssistantHeader onDockHint={setDockHint} dockHint={dockHint} />
            <AssistantChat />
        </AssistantWindow>
    );
}

/** 面板窗体：主题变量注入 + 磁吸位置 + 拖动中过渡动画。 */
function AssistantWindow({ dockHint, children }: { dockHint: "left" | "right" | "bottom" | null; children: React.ReactNode }) {
    const { t } = useTranslation();
    const dark = useThemeStore((state) => state.theme) === "dark";
    const theme = canvasThemes[dark ? "dark" : "light"];
    const geometry = useAiAssistantStore((state) => state.geometry);
    const style = useAiAssistantStore((state) => state.style);
    const magnet = useAiAssistantStore((state) => state.magnetized);
    const docked = geometry.mode !== "float";

    const position = positionFor(geometry, dockHint);
    const windowStyle = {
        ...position,
        ...themeVars(theme, dark, style),
    } as React.CSSProperties;

    return (
        <div
            className={`ai-assistant fixed z-[95] flex flex-col overflow-hidden border ${docked ? "rounded-none" : "rounded-2xl"} ${magnet ? "ai-magnet" : ""}`}
            style={windowStyle}
        >
            {children}
            {geometry.mode === "float" ? <ResizeCorner /> : <DockEdge />}
            {dockHint ? (
                <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-stone-950/40 backdrop-blur-[2px]">
                    <span className="rounded-full bg-stone-900/85 px-4 py-1.5 text-sm font-medium text-white">
                        {t(dockHint === "left" ? "aiAssistant.dockLeft" : dockHint === "right" ? "aiAssistant.dockRight" : "aiAssistant.dockBottom")}
                    </span>
                </div>
            ) : null}
        </div>
    );
}

function positionFor(geometry: AssistantGeometry, dockHint: "left" | "right" | "bottom" | null): React.CSSProperties {
    const mode = dockHint || geometry.mode;
    if (mode === "left") return { top: 0, bottom: 0, left: 0, width: geometry.dockThickness };
    if (mode === "right") return { top: 0, bottom: 0, right: 0, width: geometry.dockThickness };
    if (mode === "bottom") return { left: 0, right: 0, bottom: 0, height: geometry.dockThickness };
    return { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h };
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

/** 标题栏：拖动（磁吸 + 停靠判定）、外观设置、模式切换、最小化。 */
function AssistantHeader({ onDockHint, dockHint }: { onDockHint: (value: "left" | "right" | "bottom" | null) => void; dockHint: "left" | "right" | "bottom" | null }) {
    const { t } = useTranslation();
    const geometry = useAiAssistantStore((state) => state.geometry);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const setMagnetized = useAiAssistantStore((state) => state.setMagnetized);
    const minimize = useAiAssistantStore((state) => state.minimize);
    const drag = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

    const onPointerDown = (event: React.PointerEvent) => {
        if ((event.target as HTMLElement).closest("button")) return;
        // 停靠态下按下即切回悬浮并锚定到当前实际位置：标题栏拖动随时可用，无需先双击。
        const panel = (event.currentTarget as HTMLElement).closest(".ai-assistant") as HTMLElement | null;
        const rect = panel?.getBoundingClientRect();
        const originX = rect ? rect.x : geometry.x;
        const originY = rect ? rect.y : geometry.y;
        if (geometry.mode !== "float") setGeometry({ mode: "float", x: originX, y: originY });
        drag.current = { startX: event.clientX, startY: event.clientY, originX, originY };
        setMagnetized(false);
        const onMove = (moveEvent: PointerEvent) => {
            const state = drag.current;
            if (!state) return;
            const magnet = magnetizePanel(state.originX + moveEvent.clientX - state.startX, state.originY + moveEvent.clientY - state.startY, geometry.w, geometry.h);
            setMagnetized(magnet.sides.length > 0);
            onDockHint(dockIntentFromPointer(moveEvent.clientX, moveEvent.clientY));
            setGeometry({ x: magnet.x, y: magnet.y });
        };
        const onUp = (upEvent: PointerEvent) => {
            drag.current = null;
            setMagnetized(false);
            const intent = dockIntentFromPointer(upEvent.clientX, upEvent.clientY);
            if (intent) setGeometry({ mode: intent });
            onDockHint(null);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const iconButton = "grid size-7 shrink-0 place-items-center rounded-md transition hover:bg-[var(--ai-hover)]";

    return (
        <div
            className="flex h-11 shrink-0 cursor-grab select-none items-center gap-2 border-b px-3 active:cursor-grabbing"
            style={{ borderColor: "var(--ai-border)" }}
            onPointerDown={onPointerDown}
            onDoubleClick={() => setGeometry({ mode: geometry.mode === "float" ? "right" : "float" })}
        >
            <span className="ai-accent grid size-6 shrink-0 place-items-center rounded-lg shadow-sm" style={{ color: "var(--ai-accent-text)" }}>
                <Bot className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: "var(--ai-text)" }}>{t("aiAssistant.title")}</span>
            <Grip className="size-3.5 shrink-0 opacity-40" style={{ color: "var(--ai-text)" }} />
            <Popover trigger="click" placement="bottomRight" arrow={false} overlayStyle={{ minWidth: 264 }} content={<div className="p-3"><AssistantStyleSettings /></div>}>
                <Tooltip title={t("aiAssistant.styleSettings")}>
                    <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.styleSettings")}>
                        <SlidersHorizontal className="size-3.5" />
                    </button>
                </Tooltip>
            </Popover>
            {geometry.mode !== "left" ? (
                <Tooltip title={t("aiAssistant.dockLeft")}>
                    <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.dockLeft")} onClick={() => setGeometry({ mode: "left" })}>
                        <PanelLeft className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            {geometry.mode !== "right" ? (
                <Tooltip title={t("aiAssistant.dockRight")}>
                    <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.dockRight")} onClick={() => setGeometry({ mode: "right" })}>
                        <PanelRight className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            {geometry.mode !== "bottom" ? (
                <Tooltip title={t("aiAssistant.dockBottom")}>
                    <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.dockBottom")} onClick={() => setGeometry({ mode: "bottom" })}>
                        <PanelBottom className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            {geometry.mode !== "float" ? (
                <Tooltip title={t("aiAssistant.float")}>
                    <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.float")} onClick={() => setGeometry({ mode: "float" })}>
                        <Maximize2 className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            <Tooltip title={t("aiAssistant.minimize")}>
                <button type="button" className={iconButton} style={{ color: "var(--ai-muted)" }} aria-label={t("aiAssistant.minimize")} onClick={minimize}>
                    <ChevronDown className="size-3.5 rotate-180" />
                </button>
            </Tooltip>
        </div>
    );
}

/** 外观设置：强调色 / 毛玻璃 / 紧凑模式。 */
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

/** 悬浮态右下角尺寸手柄。 */
function ResizeCorner() {
    const geometry = useAiAssistantStore((state) => state.geometry);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const drag = useRef<{ startX: number; startY: number; w: number; h: number } | null>(null);
    return (
        <span
            className="absolute bottom-0 right-0 size-4 cursor-nwse-resize"
            onPointerDown={(event) => {
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
            onPointerUp={() => { drag.current = null; }}
            aria-hidden
        >
            <svg viewBox="0 0 16 16" className="size-full" style={{ color: "var(--ai-muted)" }}><path d="M14 6 6 14M14 11l-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </span>
    );
}

/** 停靠态内边缘拖动调厚度。 */
function DockEdge() {
    const geometry = useAiAssistantStore((state) => state.geometry);
    const setGeometry = useAiAssistantStore((state) => state.setGeometry);
    const drag = useRef<number | null>(null);
    const horizontal = geometry.mode === "bottom";
    const onLeft = geometry.mode === "left";
    const edgeStyle: React.CSSProperties = horizontal
        ? { top: 0, left: 0, right: 0, height: 6, cursor: "ns-resize" }
        : onLeft
            ? { top: 0, bottom: 0, right: 0, width: 6, cursor: "ew-resize" }
            : { top: 0, bottom: 0, left: 0, width: 6, cursor: "ew-resize" };
    return (
        <span
            className="absolute"
            style={edgeStyle}
            onPointerDown={(event) => {
                drag.current = horizontal ? event.clientY : event.clientX;
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                const start = drag.current;
                if (start === null) return;
                const delta = (horizontal ? event.clientY : event.clientX) - start;
                const max = horizontal ? window.innerHeight - 200 : Math.min(window.innerWidth - 320, 640);
                const size = Math.min(Math.max(280, horizontal || onLeft ? geometry.dockThickness + delta : geometry.dockThickness - delta), max);
                setGeometry({ dockThickness: size });
                drag.current = horizontal ? event.clientY : event.clientX;
            }}
            onPointerUp={() => { drag.current = null; }}
            aria-hidden
        />
    );
}

/** 输入区：上缘高度手柄 + 文本模型选择 + 输入框与发送。 */
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
    const inputHeight = useAiAssistantStore((state) => state.style.inputHeight);
    const setStyle = useAiAssistantStore((state) => state.setStyle);
    const selectedModel = useAiAssistantStore((state) => state.style.model);
    const config = useConfigStore((state) => state.config);
    const drag = useRef<number | null>(null);

    const modelOptions = useMemo(() => selectableModelsByCapability(config, "text").map((value) => ({
        value,
        label: modelOptionLabel(config, value) || value,
    })), [config]);
    const activeModel = selectedModel || config.model || config.textModel;

    const onHandleDown = (event: React.PointerEvent) => {
        drag.current = event.clientY;
        const onMove = (moveEvent: PointerEvent) => {
            const start = drag.current;
            if (start === null) return;
            const next = Math.min(300, Math.max(44, inputHeight + (start - moveEvent.clientY)));
            setStyle({ inputHeight: next });
            drag.current = moveEvent.clientY;
        };
        const onUp = () => {
            drag.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div className="shrink-0 border-t" style={{ borderColor: "var(--ai-border)" }}>
            <div
                className="group flex h-2 cursor-ns-resize items-center justify-center"
                onPointerDown={onHandleDown}
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("aiAssistant.inputResize")}
                title={t("aiAssistant.inputResize")}
            >
                <span className="h-0.5 w-10 rounded-full transition-all group-hover:w-16" style={{ background: "var(--ai-border)" }} />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 pb-1">
                <Select
                    size="small"
                    variant="borderless"
                    showSearch
                    optionFilterProp="label"
                    value={activeModel || undefined}
                    placeholder={t("aiAssistant.modelPlaceholder")}
                    options={modelOptions}
                    onChange={(value) => setStyle({ model: value === activeModel && !selectedModel ? "" : value })}
                    onClear={() => setStyle({ model: "" })}
                    allowClear
                    popupMatchSelectWidth={false}
                    className="ai-model-select min-w-0 flex-1 !text-xs"
                    suffixIcon={<span className="text-[10px]" style={{ color: "var(--ai-muted)" }}>{t("aiAssistant.model")}</span>}
                    aria-label={t("aiAssistant.model")}
                />
                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" icon={<Eraser className="size-3.5" />} style={{ color: "var(--ai-muted)" }} onClick={onClear} disabled={!messages.length || streaming} aria-label={t("aiAssistant.clear")} title={t("aiAssistant.clear")} />
            </div>
            <div className="flex items-end gap-2 px-2 pb-2">
                <textarea
                    className="flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-sm outline-none transition"
                    style={{ borderColor: "var(--ai-border)", color: "var(--ai-text)", height: inputHeight }}
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
                {streaming ? (
                    <Button type="primary" danger size="small" className="!h-9 !w-9 !min-w-9 !rounded-xl !p-0" icon={<CircleStop className="size-4" />} onClick={onStop} aria-label={t("aiAssistant.stop")} title={t("aiAssistant.stop")} />
                ) : (
                    <button
                        type="button"
                        className="ai-accent grid size-9 shrink-0 place-items-center rounded-xl shadow-sm transition hover:brightness-110 active:scale-95 disabled:opacity-40"
                        style={{ color: "var(--ai-accent-text)" }}
                        disabled={!draft.trim()}
                        onClick={onSend}
                        aria-label={t("aiAssistant.send")}
                        title={t("aiAssistant.send")}
                    >
                        <Send className="size-4" />
                    </button>
                )}
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

    if (message.role === "tool") {
        return (
            <div className="rounded-xl border py-2 pl-3 pr-3" style={{ ...softStyle, borderLeft: "3px solid var(--ai-accent)", background: "var(--ai-bg)" }} aria-label={message.tool}>
                <div className="mb-1 flex items-center gap-1.5 font-medium" style={{ color: "var(--ai-text)" }}>
                    <span className={`size-1.5 rounded-full ${message.error ? "bg-red-500" : message.result !== undefined ? "bg-emerald-500" : "animate-pulse"}`} style={message.error || message.result !== undefined ? undefined : { background: "var(--ai-accent)" }} />
                    <span className="font-mono">{message.tool}</span>
                    {message.error ? <span className="text-red-500">{t("aiAssistant.toolFailed")}</span> : message.result !== undefined ? <span className="text-emerald-500">{t("aiAssistant.toolDone")}</span> : <span className="animate-pulse">{t("aiAssistant.toolRunning")}</span>}
                </div>
                <pre className={`overflow-y-auto whitespace-pre-wrap break-all font-mono ${compact ? "max-h-16 text-[11px]" : "max-h-24 text-xs"}`} style={{ color: "var(--ai-muted)" }}>{JSON.stringify(message.error ?? message.result ?? message.input, null, 2)}</pre>
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
    return (
        <div className="flex justify-start gap-2">
            <span className="ai-accent mt-1 grid size-6 shrink-0 place-items-center rounded-lg shadow-sm" style={{ color: "var(--ai-accent-text)" }}>
                <Bot className="size-3.5" />
            </span>
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md border shadow-sm" style={{ ...softStyle, background: "var(--ai-bg)" }}>
                <div className={bubbleClass}>
                    {message.text || (
                        <span className="inline-flex items-center gap-1 py-1">
                            {[0, 1, 2].map((index) => (
                                <span key={index} className="size-1.5 animate-bounce rounded-full" style={{ background: "var(--ai-accent)", animationDelay: `${index * 120}ms` }} />
                            ))}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

/** 供外部（顶栏徽标等）打开 AI 助手。 */
export function useOpenAiAssistant() {
    const open = useAiAssistantStore((state) => state.open);
    return useCallback(() => open(), [open]);
}
