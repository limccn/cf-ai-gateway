// POST /api/users/:id/balance — 管理员代充/扣减（M4 4.6 / R5.1；± 均可，amount≠0）。
// 事务语义：UPDATE users.balance += amount（条件行存在）+ balance_tx(type='adjust') 流水。
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { adjustUserBalance } from "../../../lib/billing";
import { adjustBalanceInputSchema, userIdParamSchema } from "../types";

export function adjustBalanceRoute(app: Hono<AppEnv>): void {
  app.post(
    "/:id/balance",
    zValidator("param", userIdParamSchema),
    zValidator("json", adjustBalanceInputSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      const operatorId = c.get("userId");
      const db = createDb(c.env);

      const result = await adjustUserBalance(
        db,
        params.id,
        body.amount,
        body.note ?? null,
      );
      if (!result.success) {
        throw new HTTPException(404, { message: "User not found" });
      }

      logger.info("balance_adjusted", {
        targetUserId: params.id,
        byUserId: operatorId,
        amount: body.amount,
        newBalance: result.balance,
      });

      return c.json({
        success: true as const,
        balance: result.balance,
        tx: {
          id: result.txId,
          amount: body.amount,
          type: "adjust" as const,
          note: body.note ?? null,
          createdAt: result.txCreatedAt ? result.txCreatedAt.toISOString() : null,
        },
      });
    },
  );
}
