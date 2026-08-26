// GET /api/me/transactions — 当前 member 自己的余额流水（分页 + type/时间过滤）。
// userId 取自会话（/me 路径天然 self；admin 也看自己的流水，全局视角走 /api/admin/transactions）。
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { meTransactionsQuerySchema } from "../types";
import {
  fetchTransactions,
  toTransactionsOutput,
} from "../lib/queries";

export function meTransactionsRoute(app: Hono<AppEnv>): void {
  app.get(
    "/me/transactions",
    zValidator("query", meTransactionsQuerySchema),
    async (c) => {
      const logger = c.get("logger");
      const query = c.req.valid("query");
      const userId = Number(c.get("userId"));
      if (!Number.isInteger(userId) || userId <= 0) {
        // requireSession 正常已注入；防御性兜底
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      const db = createDb(c.env);

      const page = await fetchTransactions(
        db,
        { userId, type: query.type, from: query.from, to: query.to },
        query.limit,
        query.offset,
      );

      logger.info("me_transactions_reported", {
        userId,
        type: query.type ?? "all",
        total: page.total,
      });

      return c.json(
        toTransactionsOutput(page, query.limit, query.offset),
      );
    },
  );
}
