import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import CanvasEntry from "@/pages/canvas/canvas-entry";
import CanvasProjectPage from "@/pages/canvas/project";
import NotFound from "@/pages/not-found";

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <CanvasEntry /> },
            { path: "/canvas", element: <CanvasEntry /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
