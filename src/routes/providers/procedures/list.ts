// GET /api/providers — Provider 列表（admin）。密钥一律 mask，明文永不下发。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { readCircuit } from "../../../lib/provider-router";
import { toProviderResponse } from "../lib/convert";

export function listProvidersRoute(app: Hono<AppEnv>): void {
  app.get("/", async (c) => {
    const logger = c.get("logger");
    const db = createDb(c.env);
    const rows = await db.select().from(providers);
    // 断路器状态：并行 KV 读（管理 API 低频，N 次读可接受）；健康项不携带字段
    const items = await Promise.all(
      rows.map(async (row) => {
        const base = toProviderResponse(row);
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
