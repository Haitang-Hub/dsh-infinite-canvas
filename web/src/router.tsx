import { lazy, Suspense } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import NotFound from "@/pages/not-found";

// 3D 导演台编辑器依赖 three.js，体积较大，按需懒加载。
// 画布页的 Agent stage/camera/preview 工具通过隐藏 iframe 承载该页面，不在导航中展示。
const DirectorEditorPage = lazy(() => import("@/pages/director/editor-page"));

function LazyDirectorEditorPage() {
    return (
        <Suspense fallback={<div className="h-dvh w-full bg-black" />}>
            <DirectorEditorPage />
        </Suspense>
    );
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <CanvasPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
        ],
    },
    {
        // 3D 导演台编辑器：全屏独立页，由画布 Agent 以隐藏 iframe 承载
        path: "/director/editor",
        element: (
            <>
                <AnalyticsTracker />
                <LazyDirectorEditorPage />
            </>
        ),
    },
    { path: "*", element: <NotFound /> },
]);
