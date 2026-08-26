// POST /api/keys — 创建网关 API Key（member/admin）。
// 明文（prefix_xxx）仅在本次响应中返回一次；DB 只存 sha256 哈希 + 前缀（spec 强制）。
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { apiKeys } from "../../../db/schema";
import { createDb } from "../../../db";
import { generateGatewayKey, extractKeyPrefix, resolveKeyPrefix } from "../../../lib/api-keys";
import { hashToken } from "../../../lib/security";
import { createKeyInputSchema } from "../types";
import { toKeyResponse } from "../lib/convert";

export function createKeyRoute(app: Hono<AppEnv>): void {
  app.post("/", zValidator("json", createKeyInputSchema), async (c) => {
    const logger = c.get("logger");
    const body = c.req.valid("json");
    const userId = Number(c.get("userId"));
    const db = createDb(c.env);

    // 明文仅在内存中流转：生成 → 取前缀 → 哈希落库
    const plaintext = generateGatewayKey(resolveKeyPrefix(c.env.API_KEY_PREFIX));
    const hash = await hashToken(plaintext);

    const [key] = await db
      .insert(apiKeys)
      .values({
        userId,
        name: body.name,
        hash,
        prefix: extractKeyPrefix(plaintext),
        qpsLimit: body.qpsLimit,
        cacheEnabled: body.cacheEnabled,
        cacheTtl: body.cacheTtl,
      })
      .returning();
    if (!key) {
      throw new HTTPException(500, { message: "Failed to create API key" });
    }

    logger.info("api_key_created", { keyId: key.id, userId });
    return c.json({
      success: true as const,
      key: toKeyResponse(key),
      plaintext,
    });
  });
}
