// GET /v1/models — 网关可用模型列表（OpenAI 格式 `{object:"list", data:[...]}`）。
// 来源：所有 enabled Provider 的 models 路由映射（内部模型名去重后列出）。
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { providers } from "../../db/schema";
import { createDb } from "../../db";
import { parseProviderModels } from "../../lib/provider-models";

export function modelsRoute(app: Hono<AppEnv>): void {
  app.get("/models", async (c) => {
    const logger = c.get("logger");
    const db = createDb(c.env);

    const rows = await db
      .select()
      .from(providers)
      .where(eq(providers.enabled, true))
      .orderBy(asc(providers.id));

    const seen = new Set<string>();
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const models = parseProviderModels(row.models);
      const created = Math.floor(row.createdAt.getTime() / 1000);
      for (const internalModel of Object.keys(models)) {
        if (seen.has(internalModel)) {
          continue;
        }
        seen.add(internalModel);
        items.push({
          id: internalModel,
          object: "model",
          created,
          owned_by: row.name,
        });
      }
    }

    logger.info("models_listed", { total: items.length });
    return c.json({ object: "list", data: items });
  });
}
