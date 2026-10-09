// verbatim 引擎·端到端集成测试（09-28-upstream-custom-type-passthrough 批次 3）。
// 钉四件事（dispatch 验收面，AC3/AC4/AC5）：
//   ① 开集往返：未知请求体字段 / 未知响应键 / 未知 SSE 事件键以**随机标记值**（运行时
//      生成，≠ 任何已知常量，防夹具退化）逐字到达对端；
//   ② ensureStreamIncludeUsage 注入 + **负向判别力对照**：规范上游（仅显式 include_usage
//      才回 usage 尾包）下注入在 ⇒ 计费事件 100/50；永不回尾包的上游 ⇒ 计费事件 0/0、
//      消费后余额不动 —— 两支合取证明「移除注入 ⇒ 流式计费为 0」，即计费断言不是恒真
//      （它锚在注入链的下游效果上，注入一丢，B1 就退化成 B2）；
//   ③ D2 逐候选分派：同请求下 verbatim 候选与 convert 候选都成功、failover 顺序与断路
//      语义不变（circuitMemo 恰 2 读）；同一条 custom 记录双入站分流（messages 入站
//      verbatim 逐字透传 vs chat 入站经白名单转换丢弃未知字段）；
//   ④ model 反伪装：恒等映射 ⇒ **原始字节**直返（res.text() 与上游原始串全等，重序列化
//      即红）；非恒等 ⇒ 请求侧上游名、响应侧回写请求名（含流式 SSE 帧）。
// 隔离约定：候选池 = 该模型下所有 enabled provider，每个用例独立模型名（uniqueModel），
// 与 multi-upstream 同款；计费断言直接捕获网关真实 enqueue 的 BILLING_QUEUE 事件
// （替换 env.BILLING_QUEUE 为记录器，withSwitch 同款 isolate 内可见机制）再驱动消费者。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { providers, requestLogs } from "../src/db/schema";
import { consumeBillingBatch, type BillingEvent } from "../src/lib/billing-queue";
import {
  circuitKey,
  pickProvider,
  readCircuit,
  resetOpenSuppressionForTest,
  type RouteCandidate,
} from "../src/lib/provider-router";
import {
  applyMigrations,
  clearKv,
  countKvOps,
  getBalance,
  makeBillingBatch,
  selfFetch,
  setupKey,
  setupPrice,
  setupProvider,
  setupUser,
} from "./helpers";

const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
/** 预期费用 = 100×0.15 + 50×0.6 = 45 → /1e6 = 0.000045（与 multi-upstream 同口径）。 */
const EXPECTED_COST = (100 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;
/** 含缓存的预期费用（cached 封顶 promptTokens）：25×缓存价 + 75×未缓存输入价 + 50×输出价。 */
const EXPECTED_COST_CACHED =
  (25 * (INPUT_PRICE / 4) + 75 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;

let modelSeq = 0;
/** 每个用例独立模型名（候选池隔离）。 */
function uniqueModel(prefix: string): string {
  modelSeq++;
  return `v3p-${prefix}-${modelSeq}`;
}

/** 上游非流式 chat.completion 成功响应（含 usage）。 */
function okResponse(model: string): Record<string, unknown> {
  return {
    id: "chatcmpl-v3p",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** 上游 Anthropic Messages 成功响应（含 usage；usage 提取走端点方言 extractor）。 */
function anthropicOk(model: string): Record<string, unknown> {
  return {
    id: `msg_${model.replaceAll("-", "_")}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** 用 canned 响应替换全局 fetch，记录每次调用（url + init 原样）。 */
function stubUpstreamFetch(
  handler: (call: CapturedCall) => Response | Promise<Response>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: CapturedCall = { url: String(input), init: init ?? {} };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

/** 解析捕获调用的上游请求体（fetchUpstream 透传字符串 init.body）。 */
function upstreamJson(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/**
 * 用记录器替换 env.BILLING_QUEUE，捕获网关真实 enqueue 的计费事件。
 * （isolate 内 env 改写可见，countKvOps / withSwitch 同机制；restore 必须 try/finally。）
 */
function captureBillingQueue(): { sent: BillingEvent[]; restore: () => void } {
  const sent: BillingEvent[] = [];
  const original = env.BILLING_QUEUE;
  const recorder = {
    send: async (event: BillingEvent) => {
      sent.push(event);
    },
    sendBatch: async (messages: Array<{ body: BillingEvent }>) => {
      for (const message of messages) {
        sent.push(message.body);
      }
    },
  };
  env.BILLING_QUEUE = recorder as unknown as typeof original;
  return {
    sent,
    restore: () => {
      env.BILLING_QUEUE = original;
    },
  };
}

/** 等待首个计费事件到达（正向信号轮询；结算旁路经 waitUntil，异步于响应返回）。 */
async function waitForBillingEvent(sent: BillingEvent[]): Promise<BillingEvent> {
  const deadline = Date.now() + 2000;
  while (sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const event = sent[0];
  if (event === undefined) {
    throw new Error("billing event was not enqueued within 2s");
  }
  return event;
}

/** 驱动计费消费者处理捕获的事件，断言余额与流水效果。 */
async function consumeCaptured(sent: BillingEvent[]): Promise<void> {
  await consumeBillingBatch(makeBillingBatch(sent), env);
}

/** 某 key 的请求明细（id 升序 = 时序）。 */
async function logsFor(keyId: number): Promise<Array<{ providerId: number | null; status: string }>> {
  const db = createDb(env);
  const rows = await db
    .select({ providerId: requestLogs.providerId, status: requestLogs.status })
    .from(requestLogs)
    .where(eq(requestLogs.keyId, keyId))
    .orderBy(asc(requestLogs.id));
  return rows.map((r) => ({ providerId: r.providerId, status: r.status }));
}

/** 创建 key 直到其哈希落点命中 targetProviderId（哈希落点不可控，循环采样保证确定性）。 */
async function setupKeyOnProvider(
  userId: number,
  candidates: RouteCandidate[],
  targetProviderId: number,
): Promise<{ keyId: number; plaintext: string }> {
  for (let i = 0; i < 50; i++) {
    const key = await setupKey(userId);
    if (pickProvider(candidates, key.keyId).providerId === targetProviderId) {
      return key;
    }
  }
  throw new Error("no key landed on target provider within 50 attempts");
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearKv();
  resetOpenSuppressionForTest();
});

// ============ ① 开集往返（非流式 chat 面 verbatim，恒等映射字节保真） ============
describe("开集往返：未知字段随机标记值逐字到达对端（AC3/AC4）", () => {
  it("未知请求体字段 → 上游原样收到；未知响应键 → 客户端收到**原始字节**（不重序列化）", async () => {
    const model = uniqueModel("open");
    const REQ_MARKER = `rq-${crypto.randomUUID()}`;
    const RESP_MARKER = `rs-${crypto.randomUUID()}`;
    const providerId = await setupProvider("v3p-open", model, {
      type: "custom",
      baseUrl: "http://v3p-a.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser("v3p-open@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 上游原始体：双空格分隔（重序列化即被归一 ⇒ 字节全等断言有判别力）+ 未知响应键
    const rawUpstream =
      `{"id":"chatcmpl-v3p",  "object":"chat.completion",  "created":1700000000,` +
      `  "model":"${model}",  "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},` +
      `"finish_reason":"stop"}],  "usage":{"prompt_tokens":100,"completion_tokens":50},` +
      `  "vendor_extension":{"nonce":"${RESP_MARKER}","score":0.987}}`;
    const calls = stubUpstreamFetch(() => {
      return new Response(rawUpstream, { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          [`v3_marker_${REQ_MARKER}`]: { nonce: REQ_MARKER },
        }),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    // 请求侧：URL = 面端点（verbatim），未知顶层字段原样到达
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    expect(call.url).toBe("http://v3p-a.test/v1/chat/completions");
    expect(call.init.headers && (call.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-mock",
    );
    const upstreamBody = upstreamJson(call);
    expect(upstreamBody[`v3_marker_${REQ_MARKER}`]).toEqual({ nonce: REQ_MARKER });
    expect(upstreamBody["model"]).toBe(model);
    // 响应侧：原始字节直返（恒等映射 ⇒ 不重序列化；未知响应键随原始字节到达）
    expect(await res.text()).toBe(rawUpstream);
    // 计费：usage 提取与 convert 同源（verbatim 路径照常落账）
    const event = await waitForBillingEvent(billing.sent);
    expect(event.model).toBe(model);
    expect(event.providerId).toBe(providerId);
    expect(event.promptTokens).toBe(100);
    expect(event.completionTokens).toBe(50);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
  });
});

// ============ ② 流式 chat 面 verbatim：include_usage 注入 + 字节直通 + 负向判别力 ============
describe("流式 verbatim：include_usage 注入与负向判别力对照", () => {
  /** OpenAI 分帧 SSE（含未知事件键 vendor_trace + usage 尾包 + [DONE]）。 */
  function openaiSse(model: string, vendorTrace: string, withUsageTail: boolean): string {
    const frames = [
      `data: {"id":"chatcmpl-v3p","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}],"vendor_trace":"${vendorTrace}"}`,
      `data: {"id":"chatcmpl-v3p","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}`,
    ];
    if (withUsageTail) {
      frames.push(
        `data: {"id":"chatcmpl-v3p","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}`,
      );
    }
    frames.push("data: [DONE]");
    return frames.join("\n\n") + "\n\n";
  }

  it("正向：注入在（include_usage=true 到达规范上游）⇒ usage 尾包回 ⇒ 计费事件 100/50", async () => {
    const model = uniqueModel("sinc");
    const VENDOR_TRACE = `sse-${crypto.randomUUID()}`;
    await setupProvider("v3p-sinc", model, {
      type: "custom",
      baseUrl: "http://v3p-sinc.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser("v3p-sinc@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 规范上游模拟：仅显式 include_usage 才回 usage 尾包（OpenAI 真实语义）
    const calls = stubUpstreamFetch((call) => {
      const body = upstreamJson(call);
      const options = body["stream_options"] as Record<string, unknown> | undefined;
      const honors = options?.["include_usage"] === true;
      return new Response(openaiSse(String(body["model"]), VENDOR_TRACE, honors), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    // 注入 3 实路证据：上游收到的请求体带 include_usage=true
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    expect((upstreamJson(call)["stream_options"] as Record<string, unknown>)["include_usage"]).toBe(
      true,
    );
    // 字节直通：未知 SSE 事件键与 [DONE] 原样透出（恒等映射，mask 恒等短路）
    const text = await res.text();
    expect(text).toContain(`"vendor_trace":"${VENDOR_TRACE}"`);
    expect(text).toContain("data: [DONE]");
    // 计费链下游效果：usage 尾包 → 结算事件 100/50
    const event = await waitForBillingEvent(billing.sent);
    expect(event.promptTokens).toBe(100);
    expect(event.completionTokens).toBe(50);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
  });

  it("负向对照：上游永不回 usage 尾包 ⇒ 计费事件 0/0，消费后余额不动（证明正向断言锚在注入上）", async () => {
    const model = uniqueModel("sneg");
    await setupProvider("v3p-sneg", model, {
      type: "custom",
      baseUrl: "http://v3p-sneg.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser("v3p-sneg@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 无论是否被请求 include_usage，一律不回 usage 尾包（「注入被移除后上游行为」的模拟）
    stubUpstreamFetch((call) => {
      const body = upstreamJson(call);
      return new Response(openaiSse(String(body["model"]), "unused", false), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data: [DONE]");
    // 判别力：注入若被移除，规范上游停发尾包 ⇒ 结算 usage=null ⇒ 事件 0/0 ⇒ 消费者免计。
    // 本用例把这条退化链完整跑通 —— 上面的 100/50 断言因此不是恒真。
    const event = await waitForBillingEvent(billing.sent);
    expect(event.promptTokens).toBe(0);
    expect(event.completionTokens).toBe(0);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBe(10);
    const rows = await logsFor(keyId);
    expect(rows.map((r) => r.status)).toEqual(["success"]);
  });
});

// ============ ③ D2 逐候选分派：failover 顺序 / 断路语义 / circuitMemo 不变 ============
describe("D2 分派：verbatim 候选与 convert 候选都成功，failover 与 circuitMemo 不变", () => {
  it("verbatim 首选 5xx → convert（遗留 anthropic）次选成功；URL 各走各的、断路与 memo 语义不变", async () => {
    const model = uniqueModel("d2a");
    const a = await setupProvider("v3p-d2a-verb", model, {
      type: "custom",
      baseUrl: "http://v3p-d2a.test",
      protocols: JSON.stringify({ messages: {} }),
    });
    const b = await setupProvider("v3p-d2a-conv", model, {
      type: "anthropic",
      baseUrl: "http://v3p-d2b.test",
    });
    const userId = await setupUser("v3p-d2a@test.dev", 10);
    const { keyId, plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch((call) => {
      return call.url.includes("v3p-d2a.test")
        ? new Response(JSON.stringify({ error: { message: "verb boom" } }), { status: 500 })
        : new Response(JSON.stringify(anthropicOk(model)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    });

    const kv = countKvOps("circuit:");
    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/anthropic/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    } finally {
      kv.unwrap();
      billing.restore();
    }

    expect(res.status).toBe(200);
    // convert 次选的两级转换链照旧（非流式 P2a 转换语义）：客户端拿 anthropic 形态
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("message");
    // 转移顺序：verbatim 候选（面端点 URL）→ convert 候选（主端点 URL）
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("http://v3p-d2a.test/v1/messages");
    expect(calls[1]?.url).toContain("v3p-d2b.test");
    // 断路器：A 断（5xx），B 健康
    expect((await readCircuit(env.CACHE_KV, a))?.reason).toBe("5xx");
    expect(await readCircuit(env.CACHE_KV, b)).toBeNull();
    // circuitMemo 语义不变：预筛读首选 + 填充读次选 = 恰 2 读（O4.2 不变式）
    expect(kv.gets).toHaveLength(2);
    expect(kv.gets).toContain(circuitKey(a));
    expect(kv.gets).toContain(circuitKey(b));
    // 先驱动消费者落账（success 明细由计费消费者写入），再断言双明细
    const event = await waitForBillingEvent(billing.sent);
    expect(event.providerId).toBe(b);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect((await logsFor(keyId)).map((r) => [r.providerId, r.status])).toEqual([
      [a, "error"],
      [b, "success"],
    ]);
  });

  it("反向：convert 首选 5xx → verbatim 次选成功；convert 尝试丢未知字段、verbatim 尝试逐字透传", async () => {
    const model = uniqueModel("d2b");
    const REQ_MARKER = `rq-${crypto.randomUUID()}`;
    const RESP_MARKER = `rs-${crypto.randomUUID()}`;
    const a = await setupProvider("v3p-d2c-conv", model, {
      type: "anthropic",
      baseUrl: "http://v3p-d2c.test",
    });
    const b = await setupProvider("v3p-d2c-verb", model, {
      type: "custom",
      baseUrl: "http://v3p-d2d.test",
      protocols: JSON.stringify({ messages: {} }),
    });
    const userId = await setupUser("v3p-d2c@test.dev", 10);
    const { keyId, plaintext } = await setupKeyOnProvider(
      userId,
      [
        { providerId: a, weight: 1 },
        { providerId: b, weight: 1 },
      ],
      a,
    );
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // verbatim 候选响应：双空格原始串（字节保真断言）+ 未知响应键
    const rawAnthropic =
      `{"id":"msg_v3p_d2d",  "type":"message",  "role":"assistant",` +
      `  "content":[{"type":"text","text":"ok"}],  "model":"${model}",` +
      `  "stop_reason":"end_turn",  "stop_sequence":null,` +
      `  "usage":{"input_tokens":100,"output_tokens":50},` +
      `  "vendor_extension":{"nonce":"${RESP_MARKER}"}}`;
    const calls = stubUpstreamFetch((call) => {
      return call.url.includes("v3p-d2c.test")
        ? new Response(JSON.stringify({ error: { message: "conv boom" } }), { status: 500 })
        : new Response(rawAnthropic, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/anthropic/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
          vendor_marker: REQ_MARKER,
        }),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    // convert 尝试（白名单重建）：vendor_marker 被丢弃
    const convertCall = calls[0];
    const verbatimCall = calls[1];
    if (convertCall === undefined || verbatimCall === undefined) {
      throw new Error("expected two upstream attempts");
    }
    expect(upstreamJson(convertCall)["vendor_marker"]).toBeUndefined();
    // verbatim 尝试（开集透传）：vendor_marker 逐字到达；URL = 该面端点
    expect(verbatimCall.url).toBe("http://v3p-d2d.test/v1/messages");
    expect(upstreamJson(verbatimCall)["vendor_marker"]).toBe(REQ_MARKER);
    // 响应侧：原始字节直返（未知响应键随之到达；两级出站转换被跳过）
    expect(await res.text()).toBe(rawAnthropic);
    expect((await readCircuit(env.CACHE_KV, a))?.reason).toBe("5xx");
    // 先驱动消费者落账（success 明细由计费消费者写入），再断言双明细
    const event = await waitForBillingEvent(billing.sent);
    expect(event.providerId).toBe(b);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect((await logsFor(keyId)).map((r) => r.status)).toEqual(["error", "success"]);
  });

  it("同一条 custom 记录双入站分流：messages 入站 verbatim 透传未知字段，chat 入站经转换丢弃", async () => {
    const model = uniqueModel("d2c");
    const MSG_MARKER = `msg-${crypto.randomUUID()}`;
    const CHAT_MARKER = `chat-${crypto.randomUUID()}`;
    await setupProvider("v3p-d2e", model, {
      type: "custom",
      baseUrl: "http://v3p-d2e.test",
      protocols: JSON.stringify({ messages: {} }),
    });
    const userId = await setupUser("v3p-d2e@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch(() => {
      return new Response(JSON.stringify(anthropicOk(model)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // 入站 1：/anthropic/v1/messages（入站面 messages，方言 anthropic）⇒ verbatim
    const msgRes = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        vendor_marker: MSG_MARKER,
      }),
    });
    expect(msgRes.status).toBe(200);
    // 入站 2：/v1/chat/completions（入站面 chat，方言 openai ≠ 端点方言 anthropic）⇒ convert
    const chatRes = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        my_marker: CHAT_MARKER,
      }),
    });
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as Record<string, unknown>;
    // convert 路径出站形态照旧：adapter.transformResponse 产物（OpenAI 形态）
    expect(chatBody["object"]).toBe("chat.completion");

    expect(calls).toHaveLength(2);
    const msgCall = calls[0];
    const chatCall = calls[1];
    if (msgCall === undefined || chatCall === undefined) {
      throw new Error("expected two upstream calls");
    }
    // 同一条记录、同一个面端点 URL；分派条件决定请求侧形态
    expect(msgCall.url).toBe("http://v3p-d2e.test/v1/messages");
    expect(chatCall.url).toBe("http://v3p-d2e.test/v1/messages");
    expect(upstreamJson(msgCall)["vendor_marker"]).toBe(MSG_MARKER);
    expect(upstreamJson(chatCall)["my_marker"]).toBeUndefined();
    // chat 入站的 convert 响应链：messages 面无 chat 面 → 出站已转 OpenAI 形态（上面已断言）
  });
});

// ============ ④ model 反伪装（AC5）：恒等 ⇒ 字节全等；非恒等 ⇒ 请求侧/响应侧双向改写 ============
describe("model 反伪装：恒等映射原始字节直返，非恒等映射双向改写", () => {
  /** setupProvider 建模型映射后再改写为非恒等（alias → upstream）。 */
  async function rewireModels(providerId: number, alias: string, upstream: string): Promise<void> {
    const db = createDb(env);
    await db
      .update(providers)
      .set({ models: JSON.stringify({ [alias]: upstream }) })
      .where(eq(providers.id, providerId));
  }

  it("非恒等（非流式）：请求侧上游名替换、响应侧回写请求名（且上游名不出现在出站字节）", async () => {
    const alias = uniqueModel("mask-in");
    const upstreamName = `mask-up-${modelSeq}-real`;
    const providerId = await setupProvider("v3p-mask1", alias, {
      type: "custom",
      baseUrl: "http://v3p-mask1.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    await rewireModels(providerId, alias, upstreamName);
    const userId = await setupUser("v3p-mask1@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(alias, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch((call) => {
      // 上游真实名出现在响应 model 字段（伪装层的改写对象）
      const requested = String(upstreamJson(call)["model"]);
      return new Response(JSON.stringify(okResponse(requested)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          model: alias,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    const upstreamCall = calls[0];
    if (upstreamCall === undefined) {
      throw new Error("upstream was not called");
    }
    // 请求侧：上游收到映射后的真实名（注入 1 实路证据）
    expect(upstreamJson(upstreamCall)["model"]).toBe(upstreamName);
    // 响应侧：非恒等 ⇒ 解析 → maskModelInData → 重序列化；请求名回写、上游名不泄漏
    const text = await res.text();
    expect(text).not.toContain(upstreamName);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body["model"]).toBe(alias);
    // 计费口径 = 请求名（billingModel）
    const event = await waitForBillingEvent(billing.sent);
    expect(event.model).toBe(alias);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
  });

  it("非恒等（流式）：SSE 帧 model 字段回写请求名，帧结构与 usage 尾包保留", async () => {
    const alias = uniqueModel("mask-st");
    const upstreamName = `mask-st-${modelSeq}-real`;
    const providerId = await setupProvider("v3p-mask2", alias, {
      type: "custom",
      baseUrl: "http://v3p-mask2.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    await rewireModels(providerId, alias, upstreamName);
    const userId = await setupUser("v3p-mask2@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(alias, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse = [
      `data: {"id":"chatcmpl-mask","object":"chat.completion.chunk","created":1700000000,"model":"${upstreamName}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl-mask","object":"chat.completion.chunk","created":1700000000,"model":"${upstreamName}","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl-mask","object":"chat.completion.chunk","created":1700000000,"model":"${upstreamName}","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    stubUpstreamFetch(() => {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          model: alias,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    const text = await res.text();
    // 反伪装：帧内 model 全部回写请求名，上游真实名零泄漏
    expect(text).toContain(`"model":"${alias}"`);
    expect(text).not.toContain(upstreamName);
    // 帧结构与内容保留（mask 是独立字节层，只改 model 值）
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain("data: [DONE]");
    // usage 尾包照常结算
    const event = await waitForBillingEvent(billing.sent);
    expect(event.promptTokens).toBe(100);
    expect(event.completionTokens).toBe(50);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
  });
});

// ============ ⑤ Responses 面 verbatim（批次 9 缺陷修复）：Responses 原生 usage 计费 ============
// 缺陷：Responses 原生 usage 是 {input_tokens, output_tokens}（chat 口径是
// {prompt_tokens, completion_tokens}），且流式 usage 嵌在 response.completed 的
// data.response.usage —— 非流式双提取（adapter.parseUsage + extractLooseUsage）与流式
// 检测器（缺省 = chat 尾包提取器）都读不到 ⇒ 全部免计（stg 实测 11 条 responses verbatim
// 全部 0/0、余额不动）。本组钉：Responses 面流式/非流式 verbatim 照常落账（含缓存细分）、
// URL = 该面端点、字节直通保真。数值夹具 100/50/25 两两不等（防夹具退化假绿）。
describe("Responses 面 verbatim：Responses 原生 usage 计费（批次 9 缺陷修复）", () => {
  /** /v1/responses 请求体（无状态红线内：无 previous_response_id / conversation）。 */
  function responsesBody(model: string, stream: boolean): Record<string, unknown> {
    return {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 64,
      stream,
    };
  }

  it("非流式：Responses 原生 JSON → 计费事件 100/50/cached 25 + 余额按缓存口径扣除", async () => {
    const model = uniqueModel("rsp");
    const providerId = await setupProvider("v3p-rsp-n", model, {
      type: "custom",
      baseUrl: "http://v3p-rsp.test/v1",
      protocols: JSON.stringify({ responses: { policy: "verbatim" } }),
    });
    const userId = await setupUser("v3p-rsp@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 双空格原始串（重序列化即被归一 ⇒ 字节全等断言有判别力）；model 回显请求名（恒等映射）
    const rawUpstream =
      `{"id":"resp_v3p",  "object":"response",  "created_at":1700000000,` +
      `  "model":"${model}",  "status":"completed",` +
      `  "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],` +
      `  "usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,` +
      `"input_tokens_details":{"cached_tokens":25},"output_tokens_details":{"reasoning_tokens":0}},` +
      `  "vendor_extension":{"nonce":"${crypto.randomUUID()}"}}`;
    const calls = stubUpstreamFetch(() => {
      return new Response(rawUpstream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(responsesBody(model, false)),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    // 请求侧：URL = responses 面端点（verbatim），openai 方言 bearer 鉴权
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    expect(call.url).toBe("http://v3p-rsp.test/v1/responses");
    expect(call.init.headers && (call.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk-mock",
    );
    // 响应侧：恒等映射 ⇒ 原始字节直返（Responses JSON 不被重序列化）
    expect(await res.text()).toBe(rawUpstream);
    // 计费：Responses 原生 usage 形态照常落账（修复点：input/output → prompt/completion）
    const event = await waitForBillingEvent(billing.sent);
    expect(event.model).toBe(model);
    expect(event.providerId).toBe(providerId);
    expect(event.promptTokens).toBe(100);
    expect(event.completionTokens).toBe(50);
    expect(event.cachedTokens).toBe(25);
    await consumeCaptured(billing.sent);
    // 余额：cached 25 按缓存价 + 75 未缓存按输入价 + 50 按输出价（calcCost 缓存封顶口径）
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST_CACHED, 10);
  });

  it("流式：Responses SSE（usage 嵌 response.completed）→ 计费事件 100/50/cached 25 + 字节直通", async () => {
    const model = uniqueModel("rsp-s");
    await setupProvider("v3p-rsp-s", model, {
      type: "custom",
      baseUrl: "http://v3p-rsp-s.test/v1",
      protocols: JSON.stringify({ responses: { policy: "verbatim" } }),
    });
    const userId = await setupUser("v3p-rsp-s@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // Responses SSE：response.created（usage=null）→ 两个 output_text.delta →
    // response.completed（嵌套 usage）；无 [DONE] 终止符（Responses SSE 流末即终，与 chat 不同）
    const rawSse =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_v3p_s","model":"${model}","usage":null}}\n\n` +
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n` +
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_v3p_s","model":"${model}","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150,"input_tokens_details":{"cached_tokens":25},"output_tokens_details":{"reasoning_tokens":0}}}}\n\n`;
    stubUpstreamFetch(() => {
      return new Response(rawSse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(responsesBody(model, true)),
      });
    } finally {
      billing.restore();
    }

    expect(res.status).toBe(200);
    // 字节直通：Responses SSE 原样透出（恒等映射 mask 短路 + 直通分支零转换，事件名保留）
    expect(await res.text()).toBe(rawSse);
    // 计费：终局事件嵌套 usage 照常结算（修复点：检测器读 data.response.usage）
    const event = await waitForBillingEvent(billing.sent);
    expect(event.promptTokens).toBe(100);
    expect(event.completionTokens).toBe(50);
    expect(event.cachedTokens).toBe(25);
    await consumeCaptured(billing.sent);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST_CACHED, 10);
  });
});
