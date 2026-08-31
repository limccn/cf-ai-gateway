// GET /api/admin/usage — 全局用量报表（admin；user/key/model/时间范围过滤 + 分组 + 明细分页）。
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { adminUsageQuerySchema } from "../types";
import type { UsageFilters } from "../lib/queries";
import {
  fetchUsageAggregates,
  fetchUsageDetails,
  toUsageOutput,
} from "../lib/queries";

export function adminUsageRoute(app: Hono<AppEnv>): void {
  app.get(
    "/usage",
    zValidator("query", adminUsageQuerySchema),
    async (c) => {
      const logger = c.get("logger");
      const query = c.req.valid("query");
      const db = createDb(c.env);

      const filters: UsageFilters = {
        userId: query.userId,
        keyId: query.keyId,
        model: query.model,
        status: query.status,
        // range 快捷窗口优先（同 me-usage）
        ...(query.range !== undefined
          ? { range: query.range, tzOffsetMin: query.tzOffsetMin ?? 0 }
          : { from: query.from, to: query.to }),
      };
      const [aggregates, page] = await Promise.all([
        fetchUsageAggregates(db, filters, query.groupBy),
        fetchUsageDetails(db, filters, query.limit, query.offset),
      ]);

      logger.info("admin_usage_reported", {
        userId: query.userId,
        keyId: query.keyId,
        model: query.model,
        from: query.from,
        to: query.to,
        groupBy: query.groupBy ?? "none",
        total: page.total,
      });

      return c.json(toUsageOutput(aggregates, page, query.limit, query.offset));
    },
  );
}
