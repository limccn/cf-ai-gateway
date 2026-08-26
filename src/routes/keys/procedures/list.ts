// GET /api/keys — 密钥列表（member 仅自身；admin 全部，可按 userId/status 过滤）。
import { and, count, desc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { apiKeys } from "../../../db/schema";
import { createDb } from "../../../db";
import { listKeysQuerySchema } from "../types";
import { toKeyResponse } from "../lib/convert";

export function listKeysRoute(app: Hono<AppEnv>): void {
  app.get("/", zValidator("query", listKeysQuerySchema), async (c) => {
    const logger = c.get("logger");
    const query = c.req.valid("query");
    const userId = Number(c.get("userId"));
    const role = c.get("role");
    const db = createDb(c.env);

    const conditions = [];
    if (role === "admin" && query.userId) {
      conditions.push(eq(apiKeys.userId, query.userId));
    } else {
      // member：强制只看自己的 Key
      conditions.push(eq(apiKeys.userId, userId));
    }
    if (query.status) {
      conditions.push(eq(apiKeys.status, query.status));
    }
    const where = and(...conditions);

    const rows = await db
      .select()
      .from(apiKeys)
      .where(where)
      .orderBy(desc(apiKeys.id))
      .limit(query.limit)
      .offset(query.offset);
    const totalRow = await db.select({ value: count() }).from(apiKeys).where(where);
    const total = totalRow[0]?.value ?? 0;

    logger.info("api_keys_listed", { total, limit: query.limit, offset: query.offset });
    return c.json({
      success: true as const,
      items: rows.map(toKeyResponse),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
