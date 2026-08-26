// 客户端入口（M6 6.1）：React Router v7（library mode）+ React Query + Tailwind v4。
// 纯 SPA（无 SSR）：登录态由 Better Auth client 在浏览器端获取；配合 isMounted 模式
// 规避任何水合不一致（spec frontend/authentication.md：SSR-safe 规则）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "@/routes";
import { queryClient } from "@/lib/query-client";
import "./app.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
