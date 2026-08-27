// GET /api/providers — Provider 列表（admin）。密钥一律 mask，明文永不下发。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { decryptSecret } from "../../../lib/security";
import { readCircuit } from "../../../lib/provider-router";
import type { HttpOptions } from "../../../providers/types";
import { toProviderResponse } from "../lib/convert";

/** 解密 httpOptions 密文列；未配置（NULL）→ null，解密失败 → null（防御性兜底，记日志）。 */
async function decryptHttpOptions(
  encrypted: string | null,
  secretKey: string,
  logger: { warn: (msg: string, fields: Record<string, unknown>) => void },
  providerId: number,
): Promise<HttpOptions | null> {
  if (encrypted === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(await decryptSecret(encrypted, secretKey));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HttpOptions;
    }
    return null;
  } catch (error) {
    if (error instanceof Error) {
      logger.warn("http_options_decrypt_failed", {
        providerId,
        error: error.message,
      });
    }
    return null;
  }
}

export function listProvidersRoute(app: Hono<AppEnv>): void {
  app.get("/", async (c) => {
    const logger = c.get("logger");
    const db = createDb(c.env);
    const rows = await db.select().from(providers);
    // 断路器状态：并行 KV 读（管理 API 低频，N 次读可接受）；健康项不携带字段
    const items = await Promise.all(
      rows.map(async (row) => {
        const httpOptions = await decryptHttpOptions(
          row.httpOptionsEnc,
          c.env.GATEWAY_SECRET_KEY,
          logger,
          row.id,
        );
        const base = toProviderResponse(row, httpOptions);
        const circuit = await readCircuit(c.env.CACHE_KV, row.id);
        if (circuit !== null) {
          return { ...base, circuitBroken: true, circuitReason: circuit.reason };
        }
        return base;
      }),
    );
    logger.info("providers_listed", { total: rows.length });
    return c.json({
      success: true as const,
      items,
    });
  });
}
