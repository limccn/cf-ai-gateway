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
