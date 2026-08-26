// GET /api/admin/transactions — 全局余额流水（admin；可选 userId 过滤，复用同一查询）。
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { adminTransactionsQuerySchema } from "../types";
import {
  fetchTransactions,
  toTransactionsOutput,
} from "../lib/queries";

export function adminTransactionsRoute(app: Hono<AppEnv>): void {
  app.get(
    "/transactions",
    zValidator("query", adminTransactionsQuerySchema),
    async (c) => {
      const logger = c.get("logger");
      const query = c.req.valid("query");
      const db = createDb(c.env);

      const page = await fetchTransactions(
        db,
        {
          userId: query.userId,
          type: query.type,
          from: query.from,
          to: query.to,
        },
        query.limit,
        query.offset,
      );

      logger.info("admin_transactions_reported", {
        userId: query.userId,
        type: query.type ?? "all",
        total: page.total,
      });

      return c.json(
        toTransactionsOutput(page, query.limit, query.offset),
      );
    },
  );
}
