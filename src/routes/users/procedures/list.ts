// GET /api/users — 用户列表（admin；search/role/status 过滤 + limit/offset 分页）。
import { and, count, desc, eq, like, or } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { users } from "../../../db/schema";
import { createDb } from "../../../db";
import { listUsersQuerySchema } from "../types";
import { toUserResponse } from "../lib/convert";

export function listUsersRoute(app: Hono<AppEnv>): void {
  app.get("/", zValidator("query", listUsersQuerySchema), async (c) => {
    const logger = c.get("logger");
    const query = c.req.valid("query");
    const db = createDb(c.env);

    const conditions = [];
    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(like(users.email, pattern), like(users.name, pattern)),
      );
    }
    if (query.role) {
      conditions.push(eq(users.role, query.role));
    }
    if (query.status) {
      conditions.push(eq(users.status, query.status));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.id))
      .limit(query.limit)
      .offset(query.offset);
    const totalRow = await db
      .select({ value: count() })
      .from(users)
      .where(where);
    const total = totalRow[0]?.value ?? 0;

    logger.info("users_listed", {
      total,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json({
      success: true as const,
      items: rows.map(toUserResponse),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
