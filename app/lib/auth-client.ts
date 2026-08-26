// Better Auth 客户端（M6 6.2；spec frontend/authentication.md）。
// 使用官方 React 集成（better-auth/react）：提供 useSession() hook。
// baseURL 使用 window.location.origin —— 前后端同域（同一 Worker），无跨域 cookie 问题。
// 注意：不能用 "/" —— better-auth 内部会对 baseURL 执行 new URL(baseURL)，相对路径
// 会抛 "Invalid base URL: /"，导致整个 SPA bundle 崩溃（登录页黑屏）。
// 纯 SPA 无 SSR，模块只在浏览器加载；typeof 守卫仅为 typecheck 与未来 SSR 安全。
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:5173",
});
