import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Popover, Slider, Switch, Tooltip } from "antd";
import { Bot, ChevronDown, CircleStop, Eraser, Grip, Maximize2, PanelLeft, PanelRight, Send, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { requestImageQuestion } from "@/services/api/image";
import { useConfigStore } from "@/stores/use-config-store";
import { useBridgeStore } from "@/stores/use-bridge-store";
import { AGENT_ACCENT_PRESETS, useBuiltinAgentStore, type AgentPanelGeometry, type BuiltinAgentMessage } from "@/stores/use-builtin-agent-store";
import { buildSystemPrompt, MAX_TOOL_ROUNDS, parseToolCall, runBuiltinTool, toAiMessages } from "@/lib/agent/builtin-agent-tools";
import { randomId } from "@/lib/utils";

/** 拖动到视口边缘该距离内时提示停靠。 */
const DOCK_SNAP_PX = 56;
const MIN_W = 320;
const MIN_H = 360;

/**
 * 可悬浮、拖动、停靠的内置 Agent 面板：
 * - 悬浮态：标题栏拖动、右下角 resize、自由位置
 * - 停靠态：左/右贴边全高或底部横条，内边缘可拖动调厚度
 * - 最小化：收起为可点击的悬浮球
 * 外观（强调色/毛玻璃/紧凑）与几何状态均持久化。挂载在全局布局，全部页面可用。
 */
export function BuiltinAgentPanel() {
    const { t } = useTranslation();
    const geometry = useBuiltinAgentStore((state) => state.geometry);
    const style = useBuiltinAgentStore((state) => state.style);
    const setGeometry = useBuiltinAgentStore((state) => state.setGeometry);
    const busy = useBuiltinAgentStore((state) => state.busy);
    const openPanel = useBuiltinAgentStore((state) => state.openPanel);
    const [dockHint, setDockHint] = useState<AgentPanelGeometry["mode"] | null>(null);

    if (geometry.mode === "minimized") {
        return (
            <button
                type="button"
                className={`agent-accent-grad agent-fab-ring fixed bottom-6 right-6 z-[95] grid size-12 place-items-center rounded-full text-white shadow-lg transition-transform hover:scale-110 active:scale-95 ${busy ? "animate-pulse" : ""}`}
                style={{ "--agent-accent": style.accent } as React.CSSProperties}
                onClick={() => openPanel("float")}
                aria-label={t("builtinAgent.open")}
                title={t("builtinAgent.open")}
            >
                <Bot className="size-6" />
            </button>
        );
    }

    const docked = geometry.mode !== "float";
    const panelStyle = {
        ...panelPosition(geometry, dockHint),
        "--agent-accent": style.accent,
        "--agent-glass": style.glass,
        borderColor: "var(--agent-border)",
        boxShadow: "var(--agent-shadow)",
    } as React.CSSProperties;

    return (
        <div
            className={`agent-panel fixed z-[95] flex flex-col overflow-hidden border ${docked ? "rounded-none" : "rounded-2xl"}`}
            style={panelStyle}
        >
            <PanelHeader onDockHint={setDockHint} dockHint={dockHint} />
            <AgentChat />
            {geometry.mode === "float" ? <ResizeHandle /> : <DockEdgeHandle />}
            {dockHint ? (
                <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-stone-950/40 text-sm font-medium text-white backdrop-blur-[2px]">
                    <span className="rounded-full bg-stone-900/80 px-4 py-1.5">{t(dockHint === "left" ? "builtinAgent.dockLeft" : dockHint === "right" ? "builtinAgent.dockRight" : "builtinAgent.dockBottom")}</span>
                </div>
            ) : null}
        </div>
    );
}

/** 根据模式计算面板位置；拖动中若靠近边缘则按预览停靠位置显示。 */
function panelPosition(geometry: AgentPanelGeometry, dockHint: AgentPanelGeometry["mode"] | null): React.CSSProperties {
    const mode = dockHint || geometry.mode;
    if (mode === "left") return { top: 0, bottom: 0, left: 0, width: geometry.dockThickness };
    if (mode === "right") return { top: 0, bottom: 0, right: 0, width: geometry.dockThickness };
    if (mode === "bottom") return { left: 0, right: 0, bottom: 0, height: geometry.dockThickness };
    return { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h };
}

/** 标题栏：头像 + 拖动（含边缘停靠判定）+ 外观设置 + 模式切换 + 最小化。 */
function PanelHeader({ onDockHint, dockHint }: { onDockHint: (mode: AgentPanelGeometry["mode"] | null) => void; dockHint: AgentPanelGeometry["mode"] | null }) {
    const { t } = useTranslation();
    const geometry = useBuiltinAgentStore((state) => state.geometry);
    const setGeometry = useBuiltinAgentStore((state) => state.setGeometry);
    const minimize = useBuiltinAgentStore((state) => state.minimize);
    const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

    const onPointerDown = (event: React.PointerEvent) => {
        if ((event.target as HTMLElement).closest("button")) return;
        dragState.current = { startX: event.clientX, startY: event.clientY, originX: geometry.x, originY: geometry.y };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: React.PointerEvent) => {
        const drag = dragState.current;
        if (!drag) return;
        const x = drag.originX + event.clientX - drag.startX;
        const y = drag.originY + event.clientY - drag.startY;
        const nextHint = event.clientX <= DOCK_SNAP_PX ? "left" : window.innerWidth - event.clientX <= DOCK_SNAP_PX ? "right" : event.clientY >= window.innerHeight - DOCK_SNAP_PX ? "bottom" : null;
        onDockHint(nextHint);
        if (!nextHint) setGeometry({ x: clamp(x, 0, window.innerWidth - 120), y: clamp(y, 0, window.innerHeight - 48) });
    };
    const onPointerUp = () => {
        dragState.current = null;
        if (dockHint && dockHint !== "minimized") {
            setGeometry({ mode: dockHint });
            onDockHint(null);
            return;
        }
        onDockHint(null);
    };

    const iconButton = "grid size-7 place-items-center rounded-md text-stone-500 transition hover:bg-stone-500/10 hover:text-stone-700 dark:hover:text-stone-200";

    return (
        <div
            className="flex h-11 shrink-0 cursor-grab select-none items-center gap-2 border-b px-3 active:cursor-grabbing"
            style={{ borderColor: "var(--agent-border)" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => setGeometry({ mode: geometry.mode === "float" ? "right" : "float" })}
        >
            <span className="agent-accent-grad grid size-6 shrink-0 place-items-center rounded-lg text-white shadow-sm">
                <Bot className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t("builtinAgent.title")}</span>
            <Grip className="size-3.5 shrink-0 text-stone-400/70" />
            <Popover trigger="click" placement="bottomRight" arrow={false} overlayStyle={{ minWidth: 264 }} content={<div className="p-3"><StyleSettings /></div>}>
                <Tooltip title={t("builtinAgent.styleSettings")}>
                    <button type="button" className={iconButton} aria-label={t("builtinAgent.styleSettings")}>
                        <SlidersHorizontal className="size-3.5" />
                    </button>
                </Tooltip>
            </Popover>
            {geometry.mode !== "left" ? (
                <Tooltip title={t("builtinAgent.dockLeft")}>
                    <button type="button" className={iconButton} aria-label={t("builtinAgent.dockLeft")} onClick={() => setGeometry({ mode: "left" })}>
                        <PanelLeft className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            {geometry.mode !== "right" ? (
                <Tooltip title={t("builtinAgent.dockRight")}>
                    <button type="button" className={iconButton} aria-label={t("builtinAgent.dockRight")} onClick={() => setGeometry({ mode: "right" })}>
                        <PanelRight className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            {geometry.mode !== "bottom" ? (
                <Tooltip title={t("builtinAgent.dockBottom")}>
                    <button type="button" className={iconButton} aria-label={t("builtinAgent.dockBottom")} onClick={() => setGeometry({ mode: "bottom" })}>
                        <ChevronDown className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            {geometry.mode !== "float" ? (
                <Tooltip title={t("builtinAgent.float")}>
                    <button type="button" className={iconButton} aria-label={t("builtinAgent.float")} onClick={() => setGeometry({ mode: "float" })}>
                        <Maximize2 className="size-3.5" />
                    </button>
                </Tooltip>
            ) : null}
            <Tooltip title={t("builtinAgent.minimize")}>
                <button type="button" className={iconButton} aria-label={t("builtinAgent.minimize")} onClick={minimize}>
                    <ChevronDown className="size-3.5 rotate-180" />
                </button>
            </Tooltip>
        </div>
    );
}

/** 外观设置：强调色 / 毛玻璃透明度 / 紧凑模式。 */
function StyleSettings() {
    const { t } = useTranslation();
    const style = useBuiltinAgentStore((state) => state.style);
    const setStyle = useBuiltinAgentStore((state) => state.setStyle);
    return (
        <div className="space-y-4 text-xs">
            <div>
                <div className="mb-2 font-medium text-stone-600 dark:text-stone-300">{t("builtinAgent.accentColor")}</div>
                <div className="flex gap-2">
                    {AGENT_ACCENT_PRESETS.map((color) => (
                        <button
                            key={color}
                            type="button"
                            className={`size-6 rounded-full transition-transform hover:scale-110 ${style.accent === color ? "ring-2 ring-offset-2 ring-stone-400 dark:ring-offset-stone-900" : ""}`}
                            style={{ background: color }}
                            aria-label={color}
                            onClick={() => setStyle({ accent: color })}
                        />
                    ))}
                </div>
            </div>
            <div>
                <div className="mb-1 font-medium text-stone-600 dark:text-stone-300">{t("builtinAgent.glass")}</div>
                <Slider min={0} max={90} value={style.glass} onChange={(value) => setStyle({ glass: value as number })} tooltip={{ formatter: (value) => `${value}%` }} className="!my-1" />
            </div>
            <div className="flex items-center justify-between">
                <span className="font-medium text-stone-600 dark:text-stone-300">{t("builtinAgent.compact")}</span>
                <Switch size="small" checked={style.compact} onChange={(checked) => setStyle({ compact: checked })} />
            </div>
        </div>
    );
}

/** 悬浮态右下角尺寸调节手柄。 */
function ResizeHandle() {
    const geometry = useBuiltinAgentStore((state) => state.geometry);
    const setGeometry = useBuiltinAgentStore((state) => state.setGeometry);
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
                setGeometry({ w: clamp(state.w + event.clientX - state.startX, MIN_W, window.innerWidth - geometry.x - 8), h: clamp(state.h + event.clientY - state.startY, MIN_H, window.innerHeight - geometry.y - 8) });
            }}
            onPointerUp={() => { drag.current = null; }}
            aria-hidden
        >
            <svg viewBox="0 0 16 16" className="size-full text-stone-400"><path d="M14 6 6 14M14 11l-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </span>
    );
}

/** 停靠态内边缘拖动调节厚度。 */
function DockEdgeHandle() {
    const geometry = useBuiltinAgentStore((state) => state.geometry);
    const setGeometry = useBuiltinAgentStore((state) => state.setGeometry);
    const drag = useRef<number | null>(null);
    const horizontal = geometry.mode === "bottom";
    const onLeft = geometry.mode === "left";
    return (
        <span
            className={`absolute ${horizontal ? "top-0 left-0 right-0 h-1.5 cursor-ns-resize" : onLeft ? "top-0 bottom-0 right-0 w-1.5 cursor-ew-resize" : "top-0 bottom-0 left-0 w-1.5 cursor-ew-resize"}`}
            onPointerDown={(event) => {
                drag.current = horizontal ? event.clientY : event.clientX;
                (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                const start = drag.current;
                if (start === null) return;
                const delta = (horizontal ? event.clientY : event.clientX) - start;
                const max = horizontal ? window.innerHeight - 200 : Math.min(window.innerWidth - 320, 640);
                const size = clamp(horizontal ? geometry.dockThickness + delta : onLeft ? geometry.dockThickness + delta : geometry.dockThickness - delta, 280, max);
                setGeometry({ dockThickness: size });
                drag.current = horizontal ? event.clientY : event.clientX;
            }}
            onPointerUp={() => { drag.current = null; }}
            aria-hidden
        />
    );
}

/** 对话区：消息列表 + 流式输出 + 工具调用卡片 + 输入框 + 工具执行循环。 */
function AgentChat() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message: toast } = App.useApp();
    const compact = useBuiltinAgentStore((state) => state.style.compact);
    const accent = useBuiltinAgentStore((state) => state.style.accent);
    const messages = useBuiltinAgentStore((state) => state.messages);
    const streaming = useBuiltinAgentStore((state) => state.streaming);
    const addMessage = useBuiltinAgentStore((state) => state.addMessage);
    const updateMessage = useBuiltinAgentStore((state) => state.updateMessage);
    const setStreaming = useBuiltinAgentStore((state) => state.setStreaming);
    const setBusy = useBuiltinAgentStore((state) => state.setBusy);
    const clearMessages = useBuiltinAgentStore((state) => state.clearMessages);
    const [draft, setDraft] = useState("");
    const listRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [messages]);

    const toolContext = useMemo(() => {
        return {
            canvasSnapshot: useBridgeStore.getState().canvasContext?.snapshot || null,
            applyOps: (ops: unknown[]) => {
                const context = useBridgeStore.getState().canvasContext;
                if (!context) throw new Error(t("builtinAgent.noCanvas"));
                return context.applyOps(ops as never);
            },
            navigate,
        };
    }, [navigate, t]);

    const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || streaming) return;
        setDraft("");
        addMessage({ id: randomId(), role: "user", text });
        setStreaming(true);
        setBusy(true);
        abortRef.current = new AbortController();
        try {
            const config = useConfigStore.getState().config;
            let rounds = 0;
            while (rounds < MAX_TOOL_ROUNDS) {
                rounds += 1;
                const systemPrompt = buildSystemPrompt({ canvasSnapshot: useBridgeStore.getState().canvasContext?.snapshot || null, applyOps: toolContext.applyOps, navigate });
                const assistantId = randomId();
                addMessage({ id: assistantId, role: "assistant", text: "" });
                let last = "";
                const answer = await requestImageQuestion(
                    config,
                    toAiMessages(systemPrompt, useBuiltinAgentStore.getState().messages.filter((item) => item.id !== assistantId)),
                    (delta) => {
                        last = delta;
                        updateMessage(assistantId, { text: delta });
                    },
                    { signal: abortRef.current?.signal },
                );
                updateMessage(assistantId, { text: answer || last });
                const toolCall = parseToolCall(answer || last);
                if (!toolCall) break;
                const toolMessage: BuiltinAgentMessage = { id: randomId(), role: "tool", tool: toolCall.name, input: toolCall.input, round: rounds };
                addMessage(toolMessage);
                try {
                    const result = await runBuiltinTool(toolCall, toolContext);
                    updateMessage(toolMessage.id, { result });
                } catch (error) {
                    updateMessage(toolMessage.id, { error: error instanceof Error ? error.message : String(error) });
                }
            }
        } catch (error) {
            if ((error as Error).name !== "AbortError") {
                addMessage({ id: randomId(), role: "error", text: error instanceof Error ? error.message : String(error) });
                toast.error(error instanceof Error ? error.message : t("builtinAgent.requestFailed"));
            }
        } finally {
            setStreaming(false);
            setBusy(false);
            abortRef.current = null;
        }
    }, [addMessage, draft, navigate, setBusy, setStreaming, t, toast, toolContext, updateMessage]);

    const stop = () => abortRef.current?.abort();

    return (
        <>
            <div ref={listRef} className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-3 ${compact ? "py-2" : "py-3"}`}>
                {messages.length === 0 ? <EmptyHint /> : null}
                {messages.map((item) => (
                    <MessageBubble key={item.id} message={item} />
                ))}
            </div>
            <div className="flex shrink-0 items-end gap-2 border-t p-2" style={{ borderColor: "var(--agent-border)" }}>
                <Button type="text" size="small" className="!size-8 !min-w-8 !p-0 text-stone-400" icon={<Eraser className="size-4" />} onClick={clearMessages} disabled={!messages.length || streaming} aria-label={t("builtinAgent.clear")} title={t("builtinAgent.clear")} />
                <textarea
                    className="max-h-32 min-h-9 flex-1 resize-none rounded-xl border bg-transparent px-3 py-2 text-sm outline-none transition focus:border-stone-400/60"
                    style={{ borderColor: "var(--agent-border)" }}
                    rows={1}
                    value={draft}
                    placeholder={t("builtinAgent.placeholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                />
                {streaming ? (
                    <Button type="primary" danger size="small" className="!h-9 !w-9 !min-w-9 !rounded-xl !p-0" icon={<CircleStop className="size-4" />} onClick={stop} aria-label={t("builtinAgent.stop")} title={t("builtinAgent.stop")} />
                ) : (
                    <button
                        type="button"
                        className="agent-accent-grad grid size-9 shrink-0 place-items-center rounded-xl text-white shadow-sm transition hover:brightness-110 active:scale-95 disabled:opacity-40"
                        style={{ "--agent-accent": accent } as React.CSSProperties}
                        disabled={!draft.trim()}
                        onClick={() => void send()}
                        aria-label={t("builtinAgent.send")}
                        title={t("builtinAgent.send")}
                    >
                        <Send className="size-4" />
                    </button>
                )}
            </div>
        </>
    );
}

function EmptyHint() {
    const { t } = useTranslation();
    return (
        <div className="grid h-full place-items-center px-6 text-center text-xs text-stone-400">
            <div className="space-y-2">
                <span className="agent-accent-grad mx-auto grid size-10 place-items-center rounded-2xl text-white shadow">
                    <Bot className="size-5" />
                </span>
                <p>{t("builtinAgent.emptyHint")}</p>
            </div>
        </div>
    );
}

function MessageBubble({ message }: { message: BuiltinAgentMessage }) {
    const { t } = useTranslation();
    const compact = useBuiltinAgentStore((state) => state.style.compact);
    const accent = useBuiltinAgentStore((state) => state.style.accent);
    const bubble = compact ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2.5 text-sm";

    if (message.role === "tool") {
        return (
            <div className={`agent-panel-soft agent-tool-stripe rounded-xl py-2 pl-3 pr-3 ${compact ? "text-[11px]" : "text-xs"}`} style={{ "--agent-accent": accent } as React.CSSProperties}>
                <div className="mb-1 flex items-center gap-1.5 font-medium text-stone-600 dark:text-stone-300">
                    <span className={`size-1.5 rounded-full ${message.error ? "bg-red-500" : message.result !== undefined ? "bg-emerald-500" : "animate-pulse"}`} style={message.error || message.result !== undefined ? undefined : { background: accent }} />
                    <span className="font-mono">{message.tool}</span>
                    {message.error ? <span className="text-red-500">{t("builtinAgent.toolFailed")}</span> : message.result !== undefined ? <span className="text-emerald-600 dark:text-emerald-400">{t("builtinAgent.toolDone")}</span> : <span className="animate-pulse">{t("builtinAgent.toolRunning")}</span>}
                </div>
                <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-stone-500 dark:text-stone-400">{JSON.stringify(message.error ?? message.result ?? message.input, null, 2)}</pre>
            </div>
        );
    }
    if (message.role === "error") return <div className="rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{message.text}</div>;
    if (message.role === "user") {
        return (
            <div className="flex justify-end">
                <div className={`agent-msg-user max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md text-white shadow-sm ${bubble}`}>{message.text}</div>
            </div>
        );
    }
    return (
        <div className="flex justify-start gap-2">
            <span className="agent-accent-grad mt-1 grid size-6 shrink-0 place-items-center rounded-lg text-white shadow-sm" style={{ "--agent-accent": accent } as React.CSSProperties}>
                <Bot className="size-3.5" />
            </span>
            <div className={`agent-panel-soft max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-md shadow-sm ${bubble}`}>
                {message.text || (
                    <span className="inline-flex items-center gap-1 py-1">
                        {[0, 1, 2].map((index) => (
                            <span key={index} className="size-1.5 animate-bounce rounded-full" style={{ background: accent, animationDelay: `${index * 120}ms` }} />
                        ))}
                    </span>
                )}
            </div>
        </div>
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(min, value), Math.max(min, max));
}

/** 供外部（顶栏徽标等）打开面板。 */
export function useOpenBuiltinAgent() {
    const openPanel = useBuiltinAgentStore((state) => state.openPanel);
    return useCallback(() => openPanel(), [openPanel]);
}
