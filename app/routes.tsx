// 显式路由表（spec directory-structure.md：所有路由必须在此注册，非文件系统路由）。
// 非关键路由懒加载（spec quality.md：lazy-load non-critical routes）。
// 权限隔离：admin 路由在布局菜单中隐藏（AppLayout）+ 路由级拒绝（RequireAdmin）。
import { lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { RequireAdmin } from "@/components/layout/require-admin";
import { PageLoading } from "@/components/ui/states";

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  const Component = lazy(loader);
  return (
    <Suspense fallback={<PageLoading />}>
      <Component />
    </Suspense>
  );
}

export const router = createBrowserRouter([
  // 认证页（public；已登录时内部重定向到 /dashboard）
  { path: "/login", element: lazyPage(() => import("@/routes/login")) },
  { path: "/register", element: lazyPage(() => import("@/routes/register")) },

  // 受保护布局：认证守卫 + 侧边导航
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: "dashboard", element: lazyPage(() => import("@/routes/dashboard")) },
      { path: "keys", element: lazyPage(() => import("@/routes/keys")) },
      { path: "billing", element: lazyPage(() => import("@/routes/billing")) },
      { path: "usage", element: lazyPage(() => import("@/routes/usage")) },
      {
        path: "providers",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/providers"))}</RequireAdmin>,
      },
      {
        path: "models",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/models"))}</RequireAdmin>,
      },
      {
        path: "users",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/users"))}</RequireAdmin>,
      },
      {
        path: "settings",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/settings"))}</RequireAdmin>,
      },
    ],
  },

  // 404（catch-all）
  { path: "*", element: lazyPage(() => import("@/routes/not-found")) },
]);
