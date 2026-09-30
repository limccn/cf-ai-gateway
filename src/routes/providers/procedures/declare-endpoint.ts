// POST /api/providers/:id/declare-endpoint — 「声明此端点」人工回写（批次 6 G2，design §6.2）。
//
// 探测（/:id/test）只回显、无副作用；把探测事实变成路由声明是**显式人工动作**，走本路由：
//   · **人工点选，不自动写回**（探测与声明之间没有自动通路——防「偶发红 ⇒ 抹掉已生效的声明」）；
//   · **只写 protocols 子对象**：patch 结构上只有 protocols 一个键，models / quirk / type
//     没有任何进入写入的通道（AC11 由输入窄面 + 本文件的结构保证，不靠调用方自觉）；
//   · **合并语义**（merge，不是该面的整体替换）：baseUrl/policy 省略 ⇒ 保留该面已有声明的
//     对应字段（重新声明幂等）；新面两者皆省略 ⇒ 空声明 `{}`（baseUrl 继承主端点、
//     policy 取面默认 FACE_DEFAULT_POLICY——与「不复制 URL」规则一致）；
//   · preset 给默认值，探测给事实，事实优先——本路由不做任何 preset 参与，只落事实。
//
// ⚠ 解析语义（调用方/UI 必须转述给用户）：声明面**完全取代**隐式面表（design §2.2 规则 1，
// 批次 5 边界 J）——对 legacy 记录（protocols=NULL）声明一个面，会把 type 的隐式面表的
// 其余面挤出路由偏好（completions/embeddings 是独立 internal kind、无跨面转换，
// 漏声明会让这两个 kind 的入站直接 400）。这是解析层的既定语义，本路由如实执行而不悄悄
// 补齐隐式面表：补齐会让「声明了什么」失真，也违背「取代」规则的单一含义。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { decryptSecret } from "../../../lib/security";
import type { HttpOptions } from "../../../providers/types";
import {
  declareEndpointInputSchema,
  providerIdParamSchema,
  providerProtocolsSchema,
} from "../types";
import { toProviderResponse } from "../lib/convert";

export function declareEndpointRoute(app: Hono<AppEnv>): void {
  app.post(
    "/:id/declare-endpoint",
    zValidator("param", providerIdParamSchema),
    zValidator("json", declareEndpointInputSchema),
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

      // 读现有声明。损坏/非法 ⇒ 拒绝而不是覆写（不允许声明动作把坏数据"洗白"掉——
      // 那会静默丢掉管理员手工写过的面；先修声明再声明）。
      let current: Record<string, unknown> = {};
      if (existing.protocols !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing.protocols);
        } catch {
          throw new HTTPException(500, {
            message:
              "Existing protocols declaration is not valid JSON; fix it via PATCH before declaring",
          });
        }
        const check = providerProtocolsSchema.safeParse(parsed);
        if (!check.success) {
          throw new HTTPException(500, {
            message:
              "Existing protocols declaration is invalid; fix it via PATCH before declaring",
          });
        }
        current = parsed as Record<string, unknown>;
      }

      // 合并该面：已有字段保留，body 显式给的字段覆盖（zod 已拦白名单外的面与非法值）
      const face = body.face;
      const previous = current[face];
      const entry: Record<string, unknown> =
        previous !== null && typeof previous === "object" && !Array.isArray(previous)
          ? { ...(previous as Record<string, unknown>) }
          : {};
      if (body.baseUrl !== undefined) entry.baseUrl = body.baseUrl;
      if (body.policy !== undefined) entry.policy = body.policy;

      // 写前再验（防御性：合并产物不该可能非法；与 GET /presets 的输出守卫同款纵深）
      const validated = providerProtocolsSchema.parse({ ...current, [face]: entry });

      const [updated] = await db
        .update(providers)
        .set({ protocols: JSON.stringify(validated) })
        .where(eq(providers.id, existing.id))
        .returning();
      if (!updated) {
        throw new HTTPException(500, { message: "Failed to declare endpoint" });
      }

      logger.info("provider_endpoint_declared", {
        providerId: updated.id,
        face: body.face,
        ...(body.policy !== undefined ? { policy: body.policy } : {}),
      });

      // 响应回显与 PATCH 同款：解密现有 httpOptions（headers 值掩码由 toProviderResponse 做）
      let httpOptions: HttpOptions | null = null;
      if (existing.httpOptionsEnc !== null) {
        try {
          const parsed: unknown = JSON.parse(
            await decryptSecret(existing.httpOptionsEnc, c.env.GATEWAY_SECRET_KEY),
          );
          httpOptions =
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

      return c.json({
        success: true as const,
        provider: toProviderResponse(updated, httpOptions),
      });
    },
  );
}
