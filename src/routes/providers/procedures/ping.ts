// POST /api/providers/:id/ping — 上游联通性 ping（admin；批次 O，2026-09-21）。
//
// 口径与「为什么与 lib/probe.ts 刻意不复用」见 lib/ping.ts 文件头。三条边界在这里落地：
//
// 1. **不解密 provider 密钥**（不碰 `apiKeyEnc`）。这不是偷懒：密钥解不开时 `/test` 会 500
//    （"Upstream provider key decryption failed"），而 `/ping` 照样能回答「网络通不通」——
//    于是「密钥坏了」与「网络坏了」在诊断上被分开。**刻意不抽公共 loader**：把密钥排除在
//    ping 的变量作用域之外是一条安全属性，不是重复代码。
// 2. **不读 httpOptions / 不解析 models** —— 联通性与「发什么 body、带什么头」无关。
// 3. **不做任何门控**：本路由**不检查**调用方是否先 ping 过。口径是「契约不变」——
//    先 ping 后探测由 **UI 编排**（PRD 裁决 D16），服务端因此可以直接 `curl` 打 `/test`。
//    这是设计而非漏洞，故在 tests/provider-ping.test.ts 里有一条**故意的不门控测试**钉住它，
//    防止后人「顺手补个门控」把 API 用法打断。也**不要**用 KV 缓存 ping 结果来做服务端门控：
//    那会给本路由引入写副作用，与下面的「无副作用」契约直接冲突。
//
// 本路由**对网关自身无副作用**（同 /test）：不写断路器、不写 request_logs、不计网关的费、
// 不消耗网关 key、不 invalidate provider 列表。出站影响只有一条**无凭据的 HEAD**。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { providers } from "../../../db/schema";
import { createDb } from "../../../db";
import { providerIdParamSchema } from "../types";
import { PING_TIMEOUT_CAP_MS, runPing } from "../lib/ping";

export function pingProviderRoute(app: Hono<AppEnv>): void {
  app.post("/:id/ping", zValidator("param", providerIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const db = createDb(c.env);

    const existing = await db.query.providers.findFirst({
      where: eq(providers.id, params.id),
    });
    if (!existing) {
      throw new HTTPException(404, { message: "Provider not found" });
    }

    // 扁平上限，不从 existing.upstreamTimeoutMs 派生（理由见 lib/ping.ts 文件头）
    const timeoutMs = PING_TIMEOUT_CAP_MS;
    const ping = await runPing(existing.baseUrl, timeoutMs);

    // 只记结果梗概（url 是 origin 根，不含任何凭据）
    logger.info("provider_pinged", {
      providerId: existing.id,
      reachable: ping.reachable,
      status: ping.status,
      totalMs: ping.totalMs,
      timeoutMs,
    });

    return c.json({ success: true as const, timeoutMs, ping });
  });
}
