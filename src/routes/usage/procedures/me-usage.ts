// GET /api/me/usage — 当前 member 自己的用量报表（聚合 + 明细分页；越权访问他人数据 403，PRD AC6）。
import { and, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { apiKeys } from "../../../db/schema";
import { createDb } from "../../../db";
import { meUsageQuerySchema } from "../types";
import type { UsageFilters } from "../lib/queries";
import {
  fetchUsageAggregates,
  fetchUsageDetails,
  toUsageOutput,
} from "../lib/queries";

export function meUsageRoute(app: Hono<AppEnv>): void {
  app.get("/me/usage", zValidator("query", meUsageQuerySchema), async (c) => {
    const logger = c.get("logger");
    const query = c.req.valid("query");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = createDb(c.env);

    // 越权 403：member 只能按自己的 Key 过滤（他人 keyId 一律 403）
    if (query.keyId !== undefined) {
      const owned = await db.query.apiKeys.findFirst({
        where: and(eq(apiKeys.id, query.keyId), eq(apiKeys.userId, userId)),
        columns: { id: true },
      });
      if (!owned) {
        logger.warn("usage_foreign_key_forbidden", {
          userId,
          keyId: query.keyId,
        });
        throw new HTTPException(403, { message: "Forbidden" });
      }
    }

    const filters: UsageFilters = {
      userId,
      keyId: query.keyId,
      model: query.model,
      from: query.from,
      to: query.to,
    };
    const [aggregates, page] = await Promise.all([
      fetchUsageAggregates(db, filters, query.groupBy),
      fetchUsageDetails(db, filters, query.limit, query.offset),
    ]);

    logger.info("me_usage_reported", {
      userId,
      groupBy: query.groupBy ?? "none",
      total: page.total,
    });

    return c.json(toUsageOutput(aggregates, page, query.limit, query.offset));
  });
}
