import { useEffect, useState } from "react";

import { useAgentStore } from "@/stores/use-agent-store";

/** 停靠打开的 Agent 面板信息：side 为 null 表示关闭或浮动，不参与画布避让。 */
export function useAgentPanelInset(): { side: "left" | "right" | null; width: number } {
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const savedLayout = useAgentStore((state) => state.panelLayout);
    const width = useAgentStore((state) => state.width);
    const [, setTick] = useState(0);
    // 面板宽度来自 store，但"面板是否占满视口"依赖窗口尺寸，监听 resize 保证避让即时重算
    useEffect(() => {
        const onResize = () => setTick((value) => value + 1);
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);
    // 与 AgentPanel 的兜底一致：未持久化布局时默认停靠右侧
    const mode = savedLayout?.mode ?? "right";
    const side = panelOpen && mode !== "float" ? mode : null;
    return { side, width };
}
