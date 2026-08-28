import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [cloudflare(), tailwindcss()],
  resolve: {
    alias: [
      // @/ 指向 app/（spec directory-structure.md：前端 import 别名约定）
      // 注意：必须前缀匹配 @/ 开头（^@\//），@ 不是独立裸模块
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL("./app", import.meta.url)) + "/",
      },
      // React 单实例（关键修复）：react/react-dom 的 exports map 含 "react-server" 条件，
      // @cloudflare/vite-plugin 的 RSC/worker 集成会用 server conditions 二次解析这些包，
      // 产物里出现两份 React（ReactSharedInternals 互不共享 → react-dom 设置的 dispatcher
      // 对另一副本不可见 → 组件读 null dispatcher → "Cannot read properties of null
      // (reading 'useState')"，登录页白屏）。
      // 用正则精确匹配裸模块名（字符串 find 是前缀匹配，会误吞 react-dom/client），
      // 钉到具体入口文件，绕过 exports 条件解析，强制所有 import/require 收敛到同一份。
      { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-runtime.js", import.meta.url)) },
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-dev-runtime.js", import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/index.js", import.meta.url)) },
      { find: /^react-dom\/client$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/client.js", import.meta.url)) },
      // react-router 单实例（与 react 同源问题，2026-08-28 stg 实测）：exports 顶层条件
      // 第一个是 "react-server"（指向独立的 index-react-server.mjs），@cloudflare/vite-plugin
      // 二次解析后产物出现两份 react-router → RouterProvider 与路由组件各持一份
      // NavigationContext → 运行时报 "useLocation() may be used only in the context of
      // a <Router> component"（页面白屏）。钉到 production 入口绕过条件解析强制单实例。
      { find: /^react-router$/, replacement: fileURLToPath(new URL("./node_modules/react-router/dist/production/index.mjs", import.meta.url)) },
      // @tanstack/react-query 单实例（2026-08-28 stg 实测，同上机制）：exports 顶层条件是
      // "@tanstack/custom-condition"（指向 TS 源码 src/index.ts）+ import(ESM) + require(CJS)，
      // 无 module 条件——plugin 二次解析落到 CJS 或 custom 分支 → 入口（QueryClientProvider）
      // 与懒加载 chunk（dashboard/table 等 useQuery）各持一份 QueryClientContext →
      // 运行时报 "No QueryClient set, use QueryClientProvider to set one"（dashboard 白屏）。
      // 钉到 ESM 构建入口绕过条件解析强制单实例。
      {
        find: /^@tanstack\/react-query$/,
        replacement: fileURLToPath(new URL("./node_modules/@tanstack/react-query/build/modern/index.js", import.meta.url)),
      },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // react 是 CJS 包：构建时可能被解析出多份实例（@cloudflare/vite-plugin 对
        // worker/client 两侧解析 react，产物里出现两份 React → ReactSharedInternals 不
        // 共享 → 组件读到 null dispatcher → 生产环境 TypeError: Cannot read properties
        // of null (reading 'useState')，登录页白屏）。
        // advancedChunks 把所有 react 相关模块集中到单一 chunk，其余 chunk 从它 import，
        // 强制单实例（Rolldown 原生 API；manualChunks 对象语法在 Rolldown 不支持）。
        advancedChunks: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
