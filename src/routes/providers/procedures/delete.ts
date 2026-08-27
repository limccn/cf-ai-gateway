// DELETE /api/providers/:id — 删除 Provider（admin）。
// request_logs.provider_id 外键引用 providers.id（RESTRICT）：
// 有历史日志的 provider 直接删除会 FK 失败，需先解绑日志外键（置 NULL，明细保留计数/费用）。
// D1 无原生事务（不支持 BEGIN），原子性用 db.batch()（D1 批量语句原子执行）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers, requestLogs } from "../../../db/schema";
import { createDb } from "../../../db";
import { providerIdParamSchema } from "../types";

export function deleteProviderRoute(app: Hono<AppEnv>): void {
  app.delete("/:id", zValidator("param", providerIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const db = createDb(c.env);

    const existing = await db.query.providers.findFirst({
      where: eq(providers.id, params.id),
    });
    if (!existing) {
      throw new HTTPException(404, { message: "Provider not found" });
    }

    // D1 原子批处理：先解绑日志外键再删 provider（任一步失败则整批回滚）
    await db.batch([
      db.update(requestLogs).set({ providerId: null }).where(eq(requestLogs.providerId, existing.id)),
      db.delete(providers).where(eq(providers.id, existing.id)),
    ]);

    logger.warn("provider_deleted", { providerId: existing.id });
    return c.json({ success: true as const });
  });
}
