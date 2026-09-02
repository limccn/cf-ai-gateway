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

      // 解密现有 httpOptions（H5 掩码哨兵保留旧值 + 响应回显共用；未配置/解密失败 = null）
      let existingHttpOptions: HttpOptions | null = null;
      if (existing.httpOptionsEnc !== null) {
        try {
          const parsed: unknown = JSON.parse(
            await decryptSecret(existing.httpOptionsEnc, c.env.GATEWAY_SECRET_KEY),
          );
          existingHttpOptions =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as HttpOptions)
              : null;
        } catch (error) {
          if (error instanceof Error) {
            logger.warn("http_options_decrypt_failed", {
              providerId: existing.id,
              error: error.message,
            });
          }
        }
      }

      const patch: Record<string, string | boolean | number | null> = {};
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
        // H5 掩码哨兵：前端编辑回填的是掩码值（`****abcd`，见 maskHeaderValue），
        // 原样提交会把掩码**字面量**加密为新的 header 值——上游认证 header 被覆盖破坏。
        // 语义：以 `****` 开头的值 = 占位符 → 保留旧值（解密现有 httpOptions 取同名 header）；
        // 无旧值（新增的掩码条目）→ 丢弃该条目（掩码字面量绝不落库，需重输完整值才生效）。
        const next = { ...body.httpOptions };
        if (next.headers !== undefined) {
          const merged: Record<string, string> = {};
          for (const [name, value] of Object.entries(next.headers)) {
            if (value.startsWith("****")) {
              const old = existingHttpOptions?.headers?.[name];
              if (old !== undefined) {
                merged[name] = old;
              }
            } else {
              merged[name] = value;
            }
          }
          next.headers = merged;
        }
        patch.httpOptionsEnc = await encryptSecret(
          JSON.stringify(next),
          c.env.GATEWAY_SECRET_KEY,
        );
      }
      // R2 + H3：thinking_mode 显式传 null = 重置为不映射（省略 = 不改动）
      if (body.thinkingMode !== undefined) patch.thinkingMode = body.thinkingMode;
      // Workstream B：reasoning_roundtrip 显式传 false = 关闭（省略 = 不改动）
      if (body.reasoningRoundtrip !== undefined) {
        patch.reasoningRoundtrip = body.reasoningRoundtrip;
      }
      // 09-01-stg-glm-ccswitch-fix：upstream_timeout_ms 显式传 null = 重置默认 60s（省略 = 不改动）
      if (body.upstreamTimeoutMs !== undefined) {
        patch.upstreamTimeoutMs = body.upstreamTimeoutMs;
      }

      const [updated] = await db
        .update(providers)
        .set(patch)
        .where(eq(providers.id, existing.id))
        .returning();
      if (!updated) {
        throw new HTTPException(500, { message: "Failed to update provider" });
      }

      // 掩码响应（headers 值脱敏）：提交了 httpOptions → 用提交值（已做掩码哨兵合并）；
      // 未提交 → 复用顶部解密的现有值（与 create 的明文路径统一）
      let httpOptions: HttpOptions | null = null;
      if (body.httpOptions !== undefined) {
        httpOptions = body.httpOptions;
      } else {
        httpOptions = existingHttpOptions;
      }

      logger.info("provider_updated", { providerId: updated.id });
      return c.json({
        success: true as const,
        provider: toProviderResponse(updated, httpOptions),
      });
    },
  );
}
