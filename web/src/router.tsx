import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import PlatformHomePage from "@/pages/home/platform-home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";
import { isPlatformEnabled, isPromptLibraryEnabled } from "@/lib/platform";
import { PlatformSessionRoot, RequireSession } from "@/components/layout/platform-session";
import WorkspaceLayout from "@/layouts/workspace-layout";
import LoginPage from "@/pages/auth/login";
import RegisterPage from "@/pages/auth/register";
import AcceptInvitePage from "@/pages/invite/accept";
import TeamPage from "@/pages/team";
import BillingPage from "@/pages/billing";
import AdminPage from "@/pages/admin";
import BrandPage from "@/pages/brand";
import TemplatesPage from "@/pages/templates";
import { useSessionStore } from "@/stores/use-session-store";

function PlatformHome() {
    const user = useSessionStore((state) => state.user);
    return user ? <WorkspaceLayout><PlatformHomePage /></WorkspaceLayout> : <UserLayout><HomePage /></UserLayout>;
}

export const router = createBrowserRouter(isPlatformEnabled() ? [
    {
        element: <><AnalyticsTracker /><PlatformSessionRoot /></>,
        children: [
            { path: "/", element: <PlatformHome /> },
            { path: "/login", element: <LoginPage /> },
            { path: "/register", element: <RegisterPage /> },
            { path: "/invite/:token", element: <AcceptInvitePage /> },
            {
                element: <RequireSession />,
                children: [
                    { path: "/canvas/:id", element: <UserLayout><CanvasProjectPage /></UserLayout> },
                    {
                        element: <WorkspaceLayout />,
                        children: [
                            { path: "/image", element: <ImagePage /> },
                            { path: "/video", element: <VideoPage /> },
                            { path: "/assets", element: <AssetsPage /> },
                            { path: "/prompts", element: isPromptLibraryEnabled() ? <PromptsPage /> : <Navigate to="/" replace /> },
                            { path: "/canvas", element: <CanvasPage /> },
                            { path: "/config", element: <ConfigPage /> },
                            { path: "/team", element: <TeamPage /> },
                            { path: "/billing", element: <BillingPage /> },
                            { path: "/admin", element: <AdminPage /> },
                            { path: "/brand", element: <BrandPage /> },
                            { path: "/brand/:id", element: <BrandPage /> },
                            { path: "/templates", element: <TemplatesPage /> },
                        ],
                    },
                ],
            },
        ],
    },
    { path: "*", element: <NotFound /> },
] : [
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
