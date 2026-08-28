// PATCH /api/providers/:id — 更新 Provider（admin）。apiKey 省略时保持原密文。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { decryptSecret, encryptSecret } from "../../../lib/security";
import { extractSecretPrefix } from "../../../lib/mask";
import type { HttpOptions } from "../../../providers/types";
import { updateProviderInputSchema, providerIdParamSchema } from "../types";
import { toProviderResponse } from "../lib/convert";

export function updateProviderRoute(app: Hono<AppEnv>): void {
  app.patch(
    "/:id",
    zValidator("param", providerIdParamSchema),
    zValidator("json", updateProviderInputSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      const db = createDb(c.env);

      const existing = await db.query.providers.findFirst({
        where: eq(providers.id, params.id),
      });
      if (!existing) {
        throw new HTTPException(404, { message: "Provider not found" });
      }

      const patch: Record<string, string | boolean | number> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.type !== undefined) patch.type = body.type;
      if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.weight !== undefined) patch.weight = body.weight;
      if (body.models !== undefined) patch.models = JSON.stringify(body.models);
      if (body.apiKey !== undefined) {
        patch.apiKeyEnc = await encryptSecret(body.apiKey, c.env.GATEWAY_SECRET_KEY);
        patch.apiKeyPrefix = extractSecretPrefix(body.apiKey);
      }
      if (body.httpOptions !== undefined) {
        patch.httpOptionsEnc = await encryptSecret(
          JSON.stringify(body.httpOptions),
          c.env.GATEWAY_SECRET_KEY,
        );
      }

      const [updated] = await db
        .update(providers)
        .set(patch)
        .where(eq(providers.id, existing.id))
        .returning();
      if (!updated) {
        throw new HTTPException(500, { message: "Failed to update provider" });
      }

      // 本次未更新 httpOptions 时需解密原密文以生成掩码响应（与 create 的明文路径统一）
      let httpOptions: HttpOptions | null = null;
      if (body.httpOptions !== undefined) {
        httpOptions = body.httpOptions;
      } else if (updated.httpOptionsEnc !== null) {
        try {
          httpOptions = JSON.parse(
            await decryptSecret(updated.httpOptionsEnc, c.env.GATEWAY_SECRET_KEY),
          ) as HttpOptions;
        } catch (error) {
          if (error instanceof Error) {
            logger.warn("http_options_decrypt_failed", {
              providerId: updated.id,
              error: error.message,
            });
          }
        }
      }

      logger.info("provider_updated", { providerId: updated.id });
      return c.json({
        success: true as const,
        provider: toProviderResponse(updated, httpOptions),
      });
    },
  );
}
