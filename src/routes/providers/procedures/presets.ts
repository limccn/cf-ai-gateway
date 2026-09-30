// GET /api/providers/presets — preset 档案常量表（09-28 批次 5，design §2.4）。
//
// **只读**：档案本体是代码 const（src/providers/presets.ts——不建 DB 表、不做 CRUD、
// 不进迁移，用户裁决 2026-09-28）。SPA 经本端点取档案做建档预填，**不做前后端共享
// import**——先例 app/modules/models/display.ts「SPA 不该背服务端常量」：前端从 API 拿
// JSON，不 import 服务端模块（Worker 上下文/打包边界因此不进前端 bundle）。
// admin 鉴权由 router.ts 的 `app.use("*", adminOnly())` 统一前置。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { PROVIDER_PRESETS } from "../../../providers/presets";
import { listProviderPresetsOutputSchema } from "../types";

export function listProviderPresetsRoute(app: Hono<AppEnv>): void {
  app.get("/presets", (c) => {
    const body = {
      success: true as const,
      items: PROVIDER_PRESETS,
    };
    // 常量表出网前过一遍输出契约：档案形态漂移（新增字段/改面键）在这里红，
    // 而不是等前端 parse 报错——与 modelcaps 的 fail-fast 同思路。
    const parsed = listProviderPresetsOutputSchema.safeParse(body);
    if (!parsed.success) {
      const logger = c.get("logger");
      logger.error("provider_presets_schema_drift", {
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      return c.json({ success: false as const, error: "preset archive schema drift" }, 500);
    }
    return c.json(parsed.data);
  });
}
