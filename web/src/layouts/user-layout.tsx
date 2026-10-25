import type { ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { CanvasBridgeExecutor } from "@/components/bridge/canvas-bridge-executor";
import { AiAssistant } from "@/components/ai-assistant/ai-assistant";

export default function UserLayout({ children }: { children: ReactNode }) {
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <CanvasBridgeExecutor />
            <AiAssistant />
        </div>
    );
}
