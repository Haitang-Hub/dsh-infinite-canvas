import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import { Bot, ChevronDown, CircleStop, Dock, Eraser, Maximize2, PanelLeft, PanelRight, Send } from "lucide-react";
import { useTranslation } from "react-i18next";

import { requestImageQuestion } from "@/services/api/image";
import { useConfigStore } from "@/stores/use-config-store";
import { useBridgeStore } from "@/stores/use-bridge-store";
import { useBuiltinAgentStore, type AgentPanelGeometry, type BuiltinAgentMessage } from "@/stores/use-builtin-agent-store";
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
 * 几何状态持久化到 localStorage。挂载在全局布局，全部页面可用。
 */
export function BuiltinAgentPanel() {
    const { t } = useTranslation();
    const geometry = useBuiltinAgentStore((state) => state.geometry);
    const setGeometry = useBuiltinAgentStore((state) => state.setGeometry);
    const busy = useBuiltinAgentStore((state) => state.busy);
    const openPanel = useBuiltinAgentStore((state) => state.openPanel);
    const [dockHint, setDockHint] = useState<AgentPanelGeometry["mode"] | null>(null);

    if (geometry.mode === "minimized") {
        return (
            <button
                type="button"
                className={`fixed bottom-6 right-6 z-[95] grid size-12 place-items-center rounded-full text-white shadow-lg transition hover:scale-105 ${busy ? "animate-pulse" : ""}`}
                style={{ background: "linear-gradient(135deg,#78716c,#44403c)" }}
                onClick={() => openPanel("float")}
                aria-label={t("builtinAgent.open")}
                title={t("builtinAgent.open")}
            >
                <Bot className="size-6" />
            </button>
        );
    }

    const style = panelStyle(geometry, dockHint);

    return (
        <div className={`fixed z-[95] flex flex-col overflow-hidden rounded-xl border border-stone-300 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900 ${geometry.mode === "float" ? "" : "rounded-none"}`} style={style}>
            <PanelHeader
                onDockHint={setDockHint}
                dockHint={dockHint}
            />
            <AgentChat />
            {geometry.mode === "float" ? <ResizeHandle /> : <DockEdgeHandle />}
            {dockHint ? (
                <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-stone-950/30 text-sm font-medium text-white">
                    {t(dockHint === "left" ? "builtinAgent.dockLeft" : dockHint === "right" ? "builtinAgent.dockRight" : "builtinAgent.dockBottom")}
                </div>
            ) : null}
        </div>
    );
}

/** 根据模式计算面板样式；拖动中若靠近边缘则按预览停靠样式显示。 */
function panelStyle(geometry: AgentPanelGeometry, dockHint: AgentPanelGeometry["mode"] | null): React.CSSProperties {
    const mode = dockHint || geometry.mode;
    if (mode === "left") return { top: 0, bottom: 0, left: 0, width: geometry.dockThickness };
    if (mode === "right") return { top: 0, bottom: 0, right: 0, width: geometry.dockThickness };
    if (mode === "bottom") return { left: 0, right: 0, bottom: 0, height: geometry.dockThickness };
    return { left: geometry.x, top: geometry.y, width: geometry.w, height: geometry.h };
}

/** 标题栏：拖动（含边缘停靠判定）+ 模式切换 + 最小化/关闭。 */
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

    return (
        <div
            className="flex h-10 shrink-0 cursor-grab select-none items-center gap-2 border-b border-stone-200 bg-stone-100 px-3 active:cursor-grabbing dark:border-stone-700 dark:bg-stone-800"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => setGeometry({ mode: geometry.mode === "float" ? "right" : "float" })}
        >
            <Bot className="size-4 shrink-0 text-stone-500" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{t("builtinAgent.title")}</span>
            <Tooltip title={t("builtinAgent.dockLeft")}>
                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" icon={<PanelLeft className="size-3.5" />} onClick={() => setGeometry({ mode: "left" })} aria-label={t("builtinAgent.dockLeft")} />
            </Tooltip>
            <Tooltip title={t("builtinAgent.dockRight")}>
                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" icon={<PanelRight className="size-3.5" />} onClick={() => setGeometry({ mode: "right" })} aria-label={t("builtinAgent.dockRight")} />
            </Tooltip>
            <Tooltip title={t("builtinAgent.dockBottom")}>
                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" icon={<ChevronDown className="size-3.5" />} onClick={() => setGeometry({ mode: "bottom" })} aria-label={t("builtinAgent.dockBottom")} />
            </Tooltip>
            <Tooltip title={t("builtinAgent.float")}>
                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" icon={<Maximize2 className="size-3.5" />} onClick={() => setGeometry({ mode: "float" })} aria-label={t("builtinAgent.float")} />
            </Tooltip>
            <Tooltip title={t("builtinAgent.minimize")}>
                <Button type="text" size="small" className="!size-7 !min-w-7 !p-0" icon={<Dock className="size-3.5 rotate-180" />} onClick={minimize} aria-label={t("builtinAgent.minimize")} />
            </Tooltip>
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
                const size = clamp((horizontal ? geometry.dockThickness + delta - (onLeft ? 0 : 0) : onLeft ? geometry.dockThickness + delta : geometry.dockThickness - delta), 280, max);
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
        const { canvasContext } = useBridgeStore.getState();
        return {
            canvasSnapshot: canvasContext?.snapshot || null,
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
            <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
                {messages.length === 0 ? <EmptyHint /> : null}
                {messages.map((item) => (
                    <MessageBubble key={item.id} message={item} />
                ))}
            </div>
            <div className="flex shrink-0 items-end gap-2 border-t border-stone-200 p-2 dark:border-stone-700">
                <Button type="text" size="small" className="!size-8 !min-w-8 !p-0" icon={<Eraser className="size-4" />} onClick={clearMessages} disabled={!messages.length || streaming} aria-label={t("builtinAgent.clear")} title={t("builtinAgent.clear")} />
                <textarea
                    className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-stone-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-stone-400 dark:border-stone-600"
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
                    <Button type="primary" danger size="small" className="!h-8 !w-9 !min-w-9 !p-0" icon={<CircleStop className="size-4" />} onClick={stop} aria-label={t("builtinAgent.stop")} title={t("builtinAgent.stop")} />
                ) : (
                    <Button type="primary" size="small" className="!h-8 !w-9 !min-w-9 !p-0" icon={<Send className="size-4" />} onClick={() => void send()} disabled={!draft.trim()} aria-label={t("builtinAgent.send")} title={t("builtinAgent.send")} />
                )}
            </div>
        </>
    );
}

function EmptyHint() {
    const { t } = useTranslation();
    return (
        <div className="grid h-full place-items-center px-6 text-center text-xs text-stone-400">
            <div className="space-y-1">
                <Bot className="mx-auto size-8 opacity-40" />
                <p>{t("builtinAgent.emptyHint")}</p>
            </div>
        </div>
    );
}

function MessageBubble({ message }: { message: BuiltinAgentMessage }) {
    const { t } = useTranslation();
    if (message.role === "tool") {
        return (
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs dark:border-stone-700 dark:bg-stone-800/60">
                <div className="mb-1 flex items-center gap-1.5 font-medium text-stone-600 dark:text-stone-300">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    {message.tool}
                    {message.error ? <span className="text-red-500">{t("builtinAgent.toolFailed")}</span> : message.result !== undefined ? <span className="text-emerald-600">{t("builtinAgent.toolDone")}</span> : <span className="animate-pulse">{t("builtinAgent.toolRunning")}</span>}
                </div>
                <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all text-stone-500 dark:text-stone-400">{JSON.stringify(message.error ?? message.result ?? message.input, null, 2)}</pre>
            </div>
        );
    }
    if (message.role === "error") return <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">{message.text}</div>;
    if (message.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-stone-800 px-3 py-2 text-sm text-white dark:bg-stone-700">{message.text}</div>
            </div>
        );
    }
    return (
        <div className="flex justify-start">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-stone-100 px-3 py-2 text-sm dark:bg-stone-800">
                {message.text || <span className="inline-flex gap-1 py-1">{[0, 1, 2].map((index) => <span key={index} className="size-1.5 animate-bounce rounded-full bg-stone-400" style={{ animationDelay: `${index * 120}ms` }} />)}</span>}
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
