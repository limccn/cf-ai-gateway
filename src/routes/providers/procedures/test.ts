// POST /api/providers/:id/test — 上游端点探测（admin；批次 N 建，批次 6 改**逐面探测**）。
//
// 探测行 = 该记录**解析层 resolved 端点集**（parseResolvedEndpoints）：legacy 记录按遗留
// 等价面表展开（openai 三行 / anthropic 两行），custom 记录按声明面逐面一行。URL 与 proxy
// 出站构造同源（endpoints.ts 内部就是同一对函数），「探测绿 = 生产同 URL」行级成立。
// 口径与代价见 lib/probe.ts 文件头。
//
// 本路由**对网关自身无副作用**：不写断路器、不写 request_logs、不计网关的费、不消耗网关 key，
// 也**绝不自动写回 provider 行**——「声明此端点」是显式人工动作（declare-endpoint.ts）。
// 唯一的出站影响是**真实的上游调用**，成本**不保证≈0**：探测默认带 max_tokens=16，
// 但 provider 的 httpOptions.body 会覆盖它（applyHttpBody 是 Object.assign，配置值总是赢）——
// 配了 `{"max_tokens": 8192}` 或 `{"stream": true}` 的上游就按配置来，**上游那边是真计费的**。
// 这是 D11「保真优先」的代价：探测必须发生产实际会发的请求，否则配错 httpOptions 时探测反而报绿。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { decryptSecret } from "../../../lib/security";
import type { HttpOptions, ProviderConfig, ProviderType } from "../../../providers/types";
import {
  EndpointResolutionError,
  parseResolvedEndpoints,
  type ResolvedEndpoint,
} from "../../../providers/endpoints";
import { providerIdParamSchema } from "../types";
import {
  buildProbeSpecs,
  pickProbeModel,
  probeTimeoutMs,
  runProbes,
} from "../lib/probe";

export function testProviderRoute(app: Hono<AppEnv>): void {
  app.post("/:id/test", zValidator("param", providerIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const db = createDb(c.env);

    const existing = await db.query.providers.findFirst({
      where: eq(providers.id, params.id),
    });
    if (!existing) {
      throw new HTTPException(404, { message: "Provider not found" });
    }

    // 解密上游密钥（仅请求内存中使用，绝不回显/落日志）
    let apiKey: string;
    try {
      apiKey = await decryptSecret(existing.apiKeyEnc, c.env.GATEWAY_SECRET_KEY);
    } catch (error) {
      if (error instanceof Error) {
        logger.error("provider_key_decrypt_failed", {
          providerId: existing.id,
          error: error.message,
        });
      }
      throw new HTTPException(500, { message: "Upstream provider key decryption failed" });
    }

    // 高级 HTTP 选项（探测必须复用生产同款覆盖，否则配错 httpOptions 时探测会报假绿）；
    // 解密/解析失败 → 不配置（与转发路径同一兜底：增强项失败不阻断）
    let httpOptions: HttpOptions | undefined;
    if (existing.httpOptionsEnc !== null) {
      try {
        const parsed: unknown = JSON.parse(
          await decryptSecret(existing.httpOptionsEnc, c.env.GATEWAY_SECRET_KEY),
        );
        httpOptions =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as HttpOptions)
            : undefined;
      } catch (error) {
        if (error instanceof Error) {
          logger.warn("http_options_decrypt_failed", {
            providerId: existing.id,
            error: error.message,
          });
        }
        httpOptions = undefined;
      }
    }

    let models: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(existing.models);
      models =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      models = {};
    }
    const model = pickProbeModel(models);
    if (model === null) {
      throw new HTTPException(400, {
        message: "Provider has no model mapping to test with",
      });
    }

    const cfg: ProviderConfig = {
      type: existing.type as ProviderType,
      baseUrl: existing.baseUrl,
      apiKey,
      models,
      ...(httpOptions !== undefined ? { httpOptions } : {}),
    };
    const timeoutMs = probeTimeoutMs(existing.upstreamTimeoutMs);

    // 解析层真源（批次 6 G1）：探测行 = 该记录生产可达的端点面。URL 不在此拼接——
    // parseResolvedEndpoints 内部与 proxy 出站构造用同一对函数（openaiEndpointUrl /
    // anthropicMessagesUrl），「探测绿 = 生产同 URL」的同源性行级成立。
    // 放在模型映射检查之后：映射为空的 400 优先（探测一行都发不出去，先报更近的错）。
    let resolved: ResolvedEndpoint[];
    try {
      resolved = parseResolvedEndpoints({
        type: existing.type,
        baseUrl: existing.baseUrl,
        protocols: existing.protocols,
      });
    } catch (error) {
      if (error instanceof EndpointResolutionError) {
        // 记录级配置损坏（type=custom 而 protocols 缺失/损坏等）：探测无法代表生产路径，
        // 如实 400 带解析错误，不假装能探测
        throw new HTTPException(400, {
          message: `Provider endpoints cannot be resolved: ${error.message}`,
        });
      }
      throw error;
    }

    const probes = await runProbes(buildProbeSpecs(cfg, model, resolved), timeoutMs);

    // 只记结果梗概，不记 URL 之外的请求细节（密钥在 header，天然不入日志）
    logger.info("provider_tested", {
      providerId: existing.id,
      model,
      timeoutMs,
      ok: probes.filter((p) => p.ok).length,
      total: probes.length,
    });

    return c.json({ success: true as const, model, timeoutMs, probes });
  });
}
