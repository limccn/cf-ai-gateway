// GET /api/models — 价格表列表（任何已登录用户；admin 全量，member 只读已过滤视图）。
//
// 批次 P（09-14-admin-ui-adjustments-2，D18/D20）：**两处角色相关逻辑都在服务端**，
// 前端只负责渲染拿到的东西：
//   ① 行过滤：hiddenFromMembers = true 的行对 member **根本不出现在响应里**（不是前端不渲染 ——
//      devtools 的 Response 里也没有）。
//   ② 价格投影：免费模型的 5 个价对 member 置 0（toMemberModelResponse）。
// 两条都必须在服务端：放在前端只是"不显示"，改一下 devtools 就能读到真实价与隐藏行。
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { models } from "../../../db/schema";
import { createDb } from "../../../db";
import { toMemberModelResponse, toModelResponse } from "../lib/convert";

export function listModelsRoute(app: Hono<AppEnv>): void {
  app.get("/", async (c) => {
    const logger = c.get("logger");
    const isAdmin = c.get("role") === "admin";
    const db = createDb(c.env);

    const rows = await db
      .select()
      .from(models)
      .where(isAdmin ? undefined : eq(models.hiddenFromMembers, false))
      .orderBy(asc(models.model));

    logger.info("model_prices_listed", { total: rows.length, isAdmin });
    return c.json({
      success: true as const,
      items: rows.map((r) => (isAdmin ? toModelResponse(r) : toMemberModelResponse(r))),
      total: rows.length,
    });
  });
}
