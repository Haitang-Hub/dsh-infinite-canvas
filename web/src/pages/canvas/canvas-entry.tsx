import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

/**
 * 主页入口：画布即主页。hydrate 后直接进入上次编辑的画布；
 * 没有记录则取最近更新的画布；一个画布都没有则自动新建。
 * 兼容外部链接的 ?mode=new（新建并进入）与 ?mode=recent（打开最近画布）。
 */
export default function CanvasEntry() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const redirectedRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const lastProjectId = useCanvasStore((state) => state.lastProjectId);
    const createProject = useCanvasStore((state) => state.createProject);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";

    useEffect(() => {
        if (!hydrated || redirectedRef.current) return;
        redirectedRef.current = true;
        const createDefault = () => createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
        let targetId: string;
        if (mode === "new") targetId = createDefault();
        else if (mode === "recent") targetId = useCanvasStore.getState().projects[0]?.id || createDefault();
        else {
            const state = useCanvasStore.getState();
            const last = state.projects.find((project) => project.id === lastProjectId) || [...state.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            targetId = last?.id || createDefault();
        }
        // agentUrl 引导参数保存在 hash 中，navigate 不会自动携带，需要显式转发。
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${targetId}${agentQuery}${agentHash}`, { replace: true });
    }, [agentQuery, createProject, hydrated, lastProjectId, mode, navigate, projects, t]);

    return (
        <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">
            {t("canvas.opening")}
        </main>
    );
}
