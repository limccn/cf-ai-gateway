// POST /api/providers — 创建上游 Provider（admin）。
// 上游密钥 AES-GCM 加密（GATEWAY_SECRET_KEY）后落库；响应只回 mask。
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { encryptSecret } from "../../../lib/security";
import { extractSecretPrefix } from "../../../lib/mask";
import { createProviderInputSchema } from "../types";
import { toProviderResponse } from "../lib/convert";

export function createProviderRoute(app: Hono<AppEnv>): void {
  app.post("/", zValidator("json", createProviderInputSchema), async (c) => {
    const logger = c.get("logger");
    const body = c.req.valid("json");
    const db = createDb(c.env);

    const apiKeyEnc = await encryptSecret(body.apiKey, c.env.GATEWAY_SECRET_KEY);
    // httpOptions 与 apiKey 同规范 AES-GCM 加密（headers 可能含上游认证值）
    const httpOptionsEnc =
      body.httpOptions !== undefined
        ? await encryptSecret(JSON.stringify(body.httpOptions), c.env.GATEWAY_SECRET_KEY)
        : null;

    const [provider] = await db
      .insert(providers)
      .values({
        name: body.name,
        type: body.type,
        baseUrl: body.baseUrl,
        apiKeyEnc,
        apiKeyPrefix: extractSecretPrefix(body.apiKey),
        models: JSON.stringify(body.models),
        enabled: body.enabled,
        weight: body.weight,
        httpOptionsEnc,
        thinkingMode: body.thinkingMode ?? null,
        reasoningRoundtrip: body.reasoningRoundtrip ?? false,
        upstreamTimeoutMs: body.upstreamTimeoutMs ?? null,
      })
      .returning();
    if (!provider) {
      throw new HTTPException(500, { message: "Failed to create provider" });
    }

    logger.info("provider_created", { providerId: provider.id, type: provider.type });
    return c.json({
      success: true as const,
      provider: toProviderResponse(provider, body.httpOptions ?? null),
    });
  });
}
