// GET /api/me/usage/lifetime — 当前账户的**累计消费**（全时段，无筛选、无分页）。
//
// 为什么单开一个端点而不是并进 /api/me/usage 的响应：后者与 /api/admin/usage 共享
// usageOutputSchema（全链路契约），且 admin 端 userId 可缺省 —— 那时「求和」的语义是全员合计，
// 与本端点的单账户累计不是一回事。详见 types.ts 的 lifetimeCostOutputSchema 注释。
//
// 口径：取自 usage_daily（永久日汇总），**不能**取自 request_logs（受 30 天保留期裁剪，
// 算出来会随时间倒退）—— 理由与索引成本见 lib/queries.ts 的 fetchLifetimeCost。
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { fetchLifetimeCost } from "../lib/queries";

export function meLifetimeCostRoute(app: Hono<AppEnv>): void {
  app.get("/me/usage/lifetime", async (c) => {
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底（与 me-usage 同式）
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = createDb(c.env);
    const totalCost = await fetchLifetimeCost(db, userId);

    c.get("logger").info("me_usage_lifetime_reported", { userId });

    return c.json({ success: true as const, totalCost });
  });
}
