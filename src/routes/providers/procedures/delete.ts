// DELETE /api/providers/:id — 删除 Provider（admin）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
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

    await db.delete(providers).where(eq(providers.id, existing.id));

    logger.warn("provider_deleted", { providerId: existing.id });
    return c.json({ success: true as const });
  });
}
