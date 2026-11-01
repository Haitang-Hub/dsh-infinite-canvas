import { Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AppConfigModal } from "@/components/layout/app-config-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useAgentStore } from "@/stores/use-agent-store";
import { useEffect, useRef } from "react";

export function AppTopNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const autoConnectRef = useRef(false);
    const agentToken = useAgentStore((state) => state.token);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentConnected = useAgentStore((state) => state.connected);
    const connectAgent = useAgentStore((state) => state.connectAgent);
    const agentBusy = useAgentStore((state) => state.sending || state.waiting);
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const hideHeader = /^\/canvas\/[^/]+/.test(pathname);

    // 自动连接：本地存储里已有连接 token 且未连接时静默连接一次（对齐 Canvas Director）。
    useEffect(() => {
        if (autoConnectRef.current || agentEnabled || agentConnected || !agentToken.trim()) return;
        autoConnectRef.current = true;
        connectAgent({ silent: true });
    }, [agentConnected, agentEnabled, agentToken, connectAgent]);

    return (
        <>
            {!hideHeader ? (
                <header className="sticky top-0 z-20 h-14 shrink-0 border-b border-stone-200 bg-background/90 backdrop-blur-xl dark:border-stone-800">
                    <div className="mx-auto flex h-full max-w-7xl items-stretch justify-between gap-2 px-3 sm:gap-5 sm:px-6">
                        <div className="flex min-w-0 items-center">
                            <Link to="/" className="flex h-full shrink-0 items-center gap-2 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300">
                                <img src="/logo.png" alt="" className="size-5 shrink-0 object-contain" />
                                <span className="text-base font-medium">{t("meta.title")}</span>
                            </Link>
                        </div>

                        <div className="my-auto flex h-9 min-w-0 items-center justify-end gap-2 justify-self-end whitespace-nowrap">
                            <BridgeStatusBadge
                                connected={agentConnected}
                                executing={agentBusy}
                                label={t(agentBusy ? "agent.status.executing" : agentConnected ? "agent.status.connected" : "agent.status.disconnected")}
                                tooltip={t(agentBusy ? "agent.status.executingTooltip" : agentConnected ? "agent.status.connectedTooltip" : "agent.status.disconnectedTooltip")}
                                onClick={openAgentPanel}
                            />
                            <UserStatusActions />
                        </div>
                    </div>
                </header>
            ) : null}

            <AppConfigModal />
        </>
    );
}

/** 顶栏轻量徽标：MCP 画布执行器与桥服务的连接状态（在线/离线/执行中）。 */
function BridgeStatusBadge({ connected, executing, label, tooltip, onClick }: { connected: boolean; executing: boolean; label: string; tooltip: string; onClick: () => void }) {
    const color = executing ? "#d97706" : connected ? "#16a34a" : "#a8a29e";
    return (
        <Tooltip title={tooltip}>
            <button type="button" className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-stone-500 transition hover:bg-stone-100 dark:hover:bg-stone-800" aria-label={label} onClick={onClick}>
                <span className={`size-2 rounded-full ${executing ? "animate-pulse" : ""}`} style={{ background: color }} />
                <span className="hidden lg:inline">{label}</span>
            </button>
        </Tooltip>
    );
}
