// M5 用量统计单测：
// - 5.2 Queues 聚合 upsert（分组求和 / 幂等重投 / 非法消息跳过）
// - 5.3 报表 API（member 自己 / admin 全局过滤 / 越权 403 / 聚合与明细核对一致）
// - 5.4 保留期清理（scheduled cron 逻辑 + parseRetentionDays）
import { env } from "cloudflare:test";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { balanceTx, requestLogs, usageDaily } from "../src/db/schema";
import type { UsageEvent } from "../src/lib/usage-aggregation";
import { consumeUsageBatch } from "../src/lib/usage-aggregation";
import { parseRetentionDays, runRequestLogCleanup } from "../src/lib/cleanup";
import { scheduled } from "../src/index";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupKey,
  setupUser,
} from "./helpers";

// 用量批的队列名（09-21-prod-resource-naming 起为 cf-ai-gateway-usage）。
// 这里**只是标签**：queue() 的分流是「等于 BILLING_QUEUE_NAME ⇒ 计费，否则用量」，
// 故用量批不依赖此串与 [vars] 相等。分流的护栏在 tests/queue-dispatch.test.ts
// （本文件与 billing-queue.test.ts 都直驱消费者，批名对它们无效）。
const QUEUE_NAME = "cf-ai-gateway-usage";

/** 构造 Queues 批次（模拟 consumer 收到的 MessageBatch<unknown>）。 */
function makeBatch(events: UsageEvent[]): MessageBatch<unknown> {
  return {
    queue: QUEUE_NAME,
    messages: events.map((body, index) => ({
      id: `msg-${index}`,
      timestamp: new Date(body.ts),
      body,
      attempts: 1,
      retry: () => {},
      ack: () => {},
    })),
    metadata: {
      metrics: {
        backlogCount: events.length,
        backlogBytes: 0,
        oldestMessageTimestamp: new Date(),
      },
    },
    retryAll: () => {},
    ackAll: () => {},
  };
}

interface UsageResponseBody {
  success: boolean;
  aggregates: Array<{
    group: string | null;
    requests: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
  }>;
  details: Array<{
    id: number;
    keyId: number | null;
    model: string | null;
    status: string;
    createdAt: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}

async function getJson(path: string, cookie: string): Promise<UsageResponseBody> {
  const res = await selfFetch(`http://localhost${path}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as UsageResponseBody;
}

beforeAll(async () => {
  await applyMigrations();
});

describe("Queues 聚合（consumeUsageBatch → usage_daily upsert）", () => {
  it("按 (user,key,model,date) 分组求和；同日同键合并为一行", async () => {
    const userId = await setupUser("agg@test.dev", 10);
    const { keyId } = await setupKey(userId);
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o", promptTokens: 100, completionTokens: 50, cost: 0.001, status: "success", ts: Date.UTC(2026, 7, 25, 2) },
        { userId, keyId, model: "gpt-4o", promptTokens: 10, completionTokens: 5, cost: 0.0001, status: "error", ts: Date.UTC(2026, 7, 25, 6) },
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 1, completionTokens: 1, cost: 0, status: "cached", ts: Date.UTC(2026, 7, 24, 10) },
      ]),
      env,
    );

    const db = createDb(env);
    const rows = await db
      .select()
      .from(usageDaily)
      .orderBy(asc(usageDaily.date), asc(usageDaily.model));
    expect(rows).toHaveLength(2);

    const gpt4o = rows.find((r) => r.model === "gpt-4o");
    expect(gpt4o?.date).toBe("2026-08-25");
    expect(gpt4o?.requests).toBe(2);
    expect(gpt4o?.tokensIn).toBe(110);
    expect(gpt4o?.tokensOut).toBe(55);
    expect(gpt4o?.cost).toBeCloseTo(0.0011, 12);

    const mini = rows.find((r) => r.model === "gpt-4o-mini");
    expect(mini?.date).toBe("2026-08-24");
    expect(mini?.requests).toBe(1);
  });

  it("重复消费（at-least-once 重投）幂等累加：同一批再消费一次 → 数字翻倍", async () => {
    const userId = await setupUser("agg-idempotent@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const batch = makeBatch([
      { userId, keyId, model: "gpt-4o", promptTokens: 20, completionTokens: 10, cost: 0.0005, status: "success", ts: Date.UTC(2026, 7, 25, 8) },
    ]);
    await consumeUsageBatch(batch, env);
    await consumeUsageBatch(batch, env);

    const db = createDb(env);
    const row = await db.query.usageDaily.findFirst({
      where: and(eq(usageDaily.userId, userId), eq(usageDaily.model, "gpt-4o")),
    });
    expect(row?.requests).toBe(2);
    expect(row?.tokensIn).toBe(40);
    expect(row?.cost).toBeCloseTo(0.001, 12);
  });

  it("非法消息体跳过（不中断整批）", async () => {
    const userId = await setupUser("agg-invalid@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const valid: UsageEvent = { userId, keyId, model: "gpt-4o", promptTokens: 5, completionTokens: 5, cost: 0, status: "success", ts: Date.UTC(2026, 7, 25, 9) };
    await consumeUsageBatch(
      makeBatch([valid, { ...valid, cost: -1 }]), // cost < 0 → 校验失败跳过
      env,
    );

    const db = createDb(env);
    const rows = await db
      .select()
      .from(usageDaily)
      .where(eq(usageDaily.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requests).toBe(1);
  });
});

describe("GET /api/me/usage（member 自己）", () => {
  it("返回自己的聚合与明细分页；聚合与明细数字一致（抽样核对）", async () => {
    const userId = await setupUser("member@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    // 明细：成功 + 缓存各一条，跨两天
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date("2026-08-24T03:00:00Z") },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, latencyMs: 4, upstreamLatencyMs: 3, status: "cached", createdAt: new Date("2026-08-25T03:00:00Z") },
    ]);
    // 镜像聚合事件 → consumer（异步管道语义：测试中直接驱动）
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, cost: 0.001, status: "success", ts: Date.UTC(2026, 7, 24, 3) },
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, status: "cached", ts: Date.UTC(2026, 7, 25, 3) },
      ]),
      env,
    );

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson("/api/me/usage", cookie);
    expect(body.success).toBe(true);

    // 聚合总览（group=null）：requests = 明细条数，tokens/cost = 明细合计
    expect(body.aggregates).toHaveLength(1);
    expect(body.aggregates[0]?.group).toBeNull();
    expect(body.aggregates[0]?.requests).toBe(2);
    expect(body.aggregates[0]?.tokensIn).toBe(110);
    expect(body.aggregates[0]?.tokensOut).toBe(55);
    expect(body.aggregates[0]?.cost).toBeCloseTo(0.001, 12);

    // 明细（id 倒序 = 最新在前）
    expect(body.total).toBe(2);
    expect(body.details).toHaveLength(2);
    expect(body.details[0]?.status).toBe("cached");
    expect(body.details[0]?.keyId).toBe(keyId);
    expect(body.details[1]?.status).toBe("success");
  });

  it("groupBy=model 返回按模型分组聚合", async () => {
    const userId = await setupUser("member-group@test.dev", 10);
    const { keyId } = await setupKey(userId);
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0.0001, status: "success", ts: Date.UTC(2026, 7, 25, 3) },
        { userId, keyId, model: "gpt-4o", promptTokens: 20, completionTokens: 10, cost: 0.0002, status: "success", ts: Date.UTC(2026, 7, 25, 4) },
      ]),
      env,
    );

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson("/api/me/usage?groupBy=model", cookie);
    expect(body.aggregates).toHaveLength(2);
    expect(body.aggregates[0]?.group).toBe("gpt-4o");
    expect(body.aggregates[0]?.requests).toBe(1);
    expect(body.aggregates[1]?.group).toBe("gpt-4o-mini");
    expect(body.aggregates[1]?.requests).toBe(1);
  });

  it("from/to 时间范围过滤明细与聚合（含当日，UTC 日界）", async () => {
    const userId = await setupUser("member-range@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, cost: 0.001, status: "success", createdAt: new Date("2026-08-24T03:00:00Z") },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, status: "cached", createdAt: new Date("2026-08-25T03:00:00Z") },
    ]);
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, cost: 0.001, status: "success", ts: Date.UTC(2026, 7, 24, 3) },
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, status: "cached", ts: Date.UTC(2026, 7, 25, 3) },
      ]),
      env,
    );

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson("/api/me/usage?from=2026-08-25&to=2026-08-25", cookie);
    expect(body.total).toBe(1);
    expect(body.details[0]?.status).toBe("cached");
    expect(body.aggregates[0]?.requests).toBe(1);
    expect(body.aggregates[0]?.tokensIn).toBe(10);
  });

  it("member 用他人 keyId 过滤 → 403（越权）", async () => {
    const userId = await setupUser("member-a@test.dev", 10);
    const otherUserId = await setupUser("member-b@test.dev", 10);
    const { keyId: otherKeyId } = await setupKey(otherUserId);

    const cookie = sessionCookie(await createSession(userId));
    const res = await selfFetch(`http://localhost/api/me/usage?keyId=${otherKeyId}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("未登录 → 401", async () => {
    const res = await selfFetch("http://localhost/api/me/usage");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me/usage/lifetime（账户累计消费）", () => {
  /** 打一次累积端点，返回响应体（各用例共用；未登录的 401 用例不走它）。 */
  async function lifetimeBody(userId: number): Promise<{ success: boolean; totalCost: number }> {
    const cookie = sessionCookie(await createSession(userId));
    const res = await selfFetch("http://localhost/api/me/usage/lifetime", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { success: boolean; totalCost: number };
  }

  // 这条是本组**最有判别力**的一条：它锁的不是「求和」这个动作，而是**「全时段」这个口径**。
  // 若有人把数据源换回 request_logs（看起来更「实时」、且 range 模式的图表就取自它），
  // 保留期 cron 会把两年前那行删掉 → 累计值凭空变小，而本用例立刻红。
  it("汇总 usage_daily 全时段消费：远超保留期（默认 30 天）的旧行仍计入", async () => {
    const userId = await setupUser("lifetime@test.dev", 10);
    const { keyId } = await setupKey(userId);
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 1.5, status: "success", ts: Date.UTC(2026, 8, 1, 2) },
        // 两年前：request_logs 里对应行早已被保留期清理删除，usage_daily 的日汇总仍在
        { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 2.25, status: "success", ts: Date.UTC(2024, 0, 15, 2) },
      ]),
      env,
    );

    const body = await lifetimeBody(userId);
    expect(body.success).toBe(true);
    expect(body.totalCost).toBeCloseTo(3.75, 10);
  });

  it("按账户隔离：只算自己的；无用量账户回 0（不是报错）", async () => {
    const mine = await setupUser("lifetime-mine@test.dev", 10);
    const { keyId } = await setupKey(mine);
    await consumeUsageBatch(
      makeBatch([
        { userId: mine, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 4, status: "success", ts: Date.UTC(2026, 8, 1, 2) },
      ]),
      env,
    );
    const other = await setupUser("lifetime-other@test.dev", 10);

    expect((await lifetimeBody(mine)).totalCost).toBeCloseTo(4, 10);
    expect((await lifetimeBody(other)).totalCost).toBe(0);
  });

  it("未登录 → 401", async () => {
    const res = await selfFetch("http://localhost/api/me/usage/lifetime");
    expect(res.status).toBe(401);
  });
});

describe("groupBy=hour（最近 24h 逐小时聚合）", () => {
  /** Date 毫秒 → 与后端 strftime 同格式的 UTC 小时键 "YYYY-MM-DDTHH:00:00Z"。 */
  const hourKey = (ms: number) => `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;

  it("按 UTC 小时分桶；窗口外（>24h）不包含；tokens/cost 合计正确", async () => {
    const userId = await setupUser("member-hour@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    const now = Date.now();
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date(now - 3600_000) },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, latencyMs: 4, upstreamLatencyMs: 3, status: "cached", createdAt: new Date(now - 7200_000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0.00001, latencyMs: 5, upstreamLatencyMs: 4, status: "success", createdAt: new Date(now - 25 * 3600_000) },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson("/api/me/usage?groupBy=hour", cookie);
    expect(body.success).toBe(true);

    const keys = body.aggregates.map((a) => a.group);
    expect(keys).toContain(hourKey(now - 3600_000));
    expect(keys).toContain(hourKey(now - 7200_000));
    expect(keys).not.toContain(hourKey(now - 25 * 3600_000)); // 窗口外排除

    const first = body.aggregates.find((a) => a.group === hourKey(now - 3600_000));
    expect(first?.requests).toBe(1);
    expect(first?.tokensIn).toBe(100);
    expect(first?.tokensOut).toBe(50);
    expect(first?.cost).toBeCloseTo(0.001, 12);
  });

  it("groupBy=hour 支持 keyId/model 过滤；未登录仍 401", async () => {
    const userId = await setupUser("member-hour2@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);
    const now = Date.now();
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 10, completionTokens: 5, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date(now - 1800_000) },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 20, completionTokens: 10, cost: 0.002, latencyMs: 4, upstreamLatencyMs: 3, status: "success", createdAt: new Date(now - 3600_000) },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?groupBy=hour&model=gpt-4o`, cookie);
    expect(body.aggregates).toHaveLength(1);
    expect(body.aggregates[0]?.requests).toBe(1);
    expect(body.aggregates[0]?.tokensIn).toBe(10);

    const res = await selfFetch("http://localhost/api/me/usage?groupBy=hour");
    expect(res.status).toBe(401);
  });
});

describe("groupBy=status（状态占比聚合）", () => {
  it("按状态分桶；tokens/cost 合计正确；窗口外/过滤生效", async () => {
    const userId = await setupUser("member-status@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    const now = Date.now();
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date(now - 3600_000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 10, completionTokens: 5, cost: 0, latencyMs: 4, upstreamLatencyMs: 3, status: "cached", createdAt: new Date(now - 7200_000) },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 50, completionTokens: 20, cost: 0.0005, latencyMs: 8, upstreamLatencyMs: 6, status: "error", createdAt: new Date(now - 10800_000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0.00001, latencyMs: 5, upstreamLatencyMs: 4, status: "rejected", createdAt: new Date(now - 14400_000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0.00001, latencyMs: 5, upstreamLatencyMs: 4, status: "success", createdAt: new Date(now - 25 * 3600_000) },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson("/api/me/usage?groupBy=status", cookie);
    expect(body.success).toBe(true);

    // 4 状态各一桶（窗口内 4 条；25h 前的 success 不因窗口排除——status 聚合 respect from/to，无窗口）
    expect(body.aggregates).toHaveLength(4);
    const byGroup = new Map(body.aggregates.map((a) => [a.group, a]));
    expect(byGroup.get("success")?.requests).toBe(2);
    expect(byGroup.get("success")?.tokensIn).toBe(101);
    expect(byGroup.get("success")?.tokensOut).toBe(51);
    expect(byGroup.get("success")?.cost).toBeCloseTo(0.00101, 12);
    expect(byGroup.get("cached")?.requests).toBe(1);
    expect(byGroup.get("cached")?.tokensIn).toBe(10);
    expect(byGroup.get("error")?.requests).toBe(1);
    expect(byGroup.get("error")?.cost).toBeCloseTo(0.0005, 12);
    expect(byGroup.get("rejected")?.requests).toBe(1);
  });

  it("groupBy=status 支持 from/to 与 model 过滤；未登录 401", async () => {
    const userId = await setupUser("member-status2@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 10, completionTokens: 5, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date("2026-08-24T03:00:00Z") },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 20, completionTokens: 10, cost: 0.002, latencyMs: 4, upstreamLatencyMs: 3, status: "error", createdAt: new Date("2026-08-25T03:00:00Z") },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    // from/to 过滤：只看 08-25
    const body = await getJson("/api/me/usage?groupBy=status&from=2026-08-25&to=2026-08-25", cookie);
    expect(body.aggregates).toHaveLength(1);
    expect(body.aggregates[0]?.group).toBe("error");
    expect(body.aggregates[0]?.requests).toBe(1);

    // model 过滤：只看 gpt-4o
    const body2 = await getJson("/api/me/usage?groupBy=status&model=gpt-4o", cookie);
    expect(body2.aggregates).toHaveLength(1);
    expect(body2.aggregates[0]?.group).toBe("success");
    expect(body2.aggregates[0]?.requests).toBe(1);

    const res = await selfFetch("http://localhost/api/me/usage?groupBy=status");
    expect(res.status).toBe(401);
  });
});

describe("status 过滤（Request details 状态筛选）", () => {
  it("status 只过滤明细与 request_logs 聚合；date 聚合不受影响", async () => {
    const userId = await setupUser("member-sf@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    const now = Date.now();
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date(now - 3600_000) },
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, latencyMs: 4, upstreamLatencyMs: 3, status: "error", createdAt: new Date(now - 7200_000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 30, completionTokens: 15, cost: 0.0003, latencyMs: 8, upstreamLatencyMs: 6, status: "error", createdAt: new Date(now - 10800_000) },
    ]);
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o", promptTokens: 100, completionTokens: 50, cost: 0.001, status: "success", ts: now - 3600_000 },
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 10, completionTokens: 5, cost: 0, status: "error", ts: now - 7200_000 },
        { userId, keyId, model: "gpt-4o", promptTokens: 30, completionTokens: 15, cost: 0.0003, status: "error", ts: now - 10800_000 },
      ]),
      env,
    );

    const cookie = sessionCookie(await createSession(userId));

    // 只过滤明细：details 全为 error、total=2；date 聚合（usage_daily）仍含全部 3 条
    const body = await getJson("/api/me/usage?status=error", cookie);
    expect(body.details).toHaveLength(2);
    expect(body.details.every((d) => d.status === "error")).toBe(true);
    expect(body.total).toBe(2);
    const dailySum = body.aggregates.reduce((s, a) => s + a.requests, 0);
    expect(dailySum).toBe(3);

    // 组合过滤：status=error + model
    const body2 = await getJson("/api/me/usage?status=error&model=gpt-4o", cookie);
    expect(body2.details).toHaveLength(1);
    expect(body2.details[0]?.model).toBe("gpt-4o");
    expect(body2.total).toBe(1);

    // hour 聚合联动（同 request_logs 口径）：只看 error
    const body3 = await getJson("/api/me/usage?groupBy=hour&status=error", cookie);
    const hourlySum = body3.aggregates.reduce((s, a) => s + a.requests, 0);
    expect(hourlySum).toBe(2);

    // status 占比聚合联动：只看 error
    const body4 = await getJson("/api/me/usage?groupBy=status&status=error", cookie);
    expect(body4.aggregates).toHaveLength(1);
    expect(body4.aggregates[0]?.group).toBe("error");
    expect(body4.aggregates[0]?.requests).toBe(2);
  });

  it("非法 status 值 → 400；未登录 401", async () => {
    const userId = await setupUser("member-sf2@test.dev", 10);
    const cookie = sessionCookie(await createSession(userId));

    const res = await selfFetch("http://localhost/api/me/usage?status=bogus", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);

    const anon = await selfFetch("http://localhost/api/me/usage?status=error");
    expect(anon.status).toBe(401);
  });
});

describe("range 快捷维度（08-31-usage-stats-dimensions）", () => {
  /**
   * 造数辅助：相对「当前时刻的本地日界」偏移插入 request_logs。
   * tzOffsetMin 与 API 一致：UTC+8 → 480。本地日 0:00 的 UTC 时刻 = floor((now+off)/day)*day - off。
   */
  function seedLogs(
    userId: number,
    keyId: number,
    logs: Array<{ label: string; ms: number; model?: string }>,
  ): Promise<void> {
    const db = createDb(env);
    return db.insert(requestLogs).values(
      logs.map((log) => ({
        userId,
        keyId,
        model: log.model ?? "gpt-4o",
        promptTokens: 10,
        completionTokens: 5,
        cost: 0.001,
        status: "success",
        createdAt: new Date(log.ms),
      })),
    ).then(() => undefined);
  }
  const localStart = (tzOffsetMin: number) => {
    const off = tzOffsetMin * 60_000;
    const now = Date.now();
    return Math.floor((now + off) / 86_400_000) * 86_400_000 - off;
  };
  const hourKey = (ms: number, tzOffsetMin: number) => {
    const shifted = new Date(ms + tzOffsetMin * 60_000);
    return `${shifted.toISOString().slice(0, 13)}:00:00Z`;
  };
  const dayKey = (ms: number, tzOffsetMin: number) => {
    const shifted = new Date(ms + tzOffsetMin * 60_000);
    return shifted.toISOString().slice(0, 10);
  };
  const DAY = 86_400_000;

  it("range=today&tzOffsetMin=480：本地日界分桶（跨 UTC 日界数据入本地日期），窗口外排除", async () => {
    const userId = await setupUser("range-today@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    // 本地今日 04:00（UTC 昨日 20:00，跨 UTC 日界）、本地今日 10:00；本地昨日 23:00（窗口外）
    await seedLogs(userId, keyId, [
      { label: "today-04", ms: localToday + 4 * 3600_000 },
      { label: "today-10", ms: localToday + 10 * 3600_000 },
      { label: "yesterday-23", ms: localToday - 3600_000 },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=today&tzOffsetMin=${tz}`, cookie);
    expect(body.success).toBe(true);

    // 两条入同桶（本地今日 04:00 与 10:00 不同桶；窗口外数据排除）
    const keys = body.aggregates.map((a) => a.group);
    expect(keys).toContain(hourKey(localToday + 4 * 3600_000, tz));
    expect(keys).toContain(hourKey(localToday + 10 * 3600_000, tz));
    expect(keys).not.toContain(hourKey(localToday - 3600_000, tz)); // 本地昨日（UTC 今日）排除
    const agg = body.aggregates.find((a) => a.group === hourKey(localToday + 4 * 3600_000, tz));
    expect(agg?.requests).toBe(1);
    expect(agg?.tokensIn).toBe(10);
    expect(agg?.cost).toBeCloseTo(0.001, 12);
    // 明细同窗口
    expect(body.total).toBe(2);
  });

  it("range=yesterday&tzOffsetMin=480：本地昨日桶；本地今日数据排除", async () => {
    const userId = await setupUser("range-yesterday@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    await seedLogs(userId, keyId, [
      { label: "y-day-04", ms: localToday - 20 * 3600_000 }, // 本地昨日 04:00
      { label: "y-day-10", ms: localToday - 14 * 3600_000 }, // 本地昨日 10:00
      { label: "today-02", ms: localToday + 2 * 3600_000 }, // 本地今日（排除）
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=yesterday&tzOffsetMin=${tz}`, cookie);
    expect(body.aggregates.map((a) => a.group)).toContain(hourKey(localToday - 20 * 3600_000, tz));
    expect(body.aggregates).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it("range=last14 / last30：天桶端点（含今日），明细窗口边界正确", async () => {
    const userId = await setupUser("range-last@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 0;
    const localToday = localStart(tz);
    const seed = async (daysBack: number, hourOffsetMs = 0) =>
      seedLogs(userId, keyId, [{ label: `d${daysBack}`, ms: localToday - daysBack * DAY + hourOffsetMs }]);

    // last14 边界：今天（含）、13 天前（含）、14 天前（排除）
    // last30 边界：今天（含）、29 天前（含）、30 天前（排除）
    await seed(0);
    await seed(13);
    await seed(14);
    await seed(29);
    await seed(30);
    const cookie = sessionCookie(await createSession(userId));
    const body14 = await getJson(`/api/me/usage?range=last14`, cookie);
    const keys14 = body14.aggregates.map((a) => a.group);
    expect(keys14).toContain(dayKey(localToday, tz));
    expect(keys14).toContain(dayKey(localToday - 13 * DAY, tz));
    expect(keys14).not.toContain(dayKey(localToday - 14 * DAY, tz));
    expect(body14.total).toBe(2);

    // last30 边界：今天 + 29 天前（含）；30 天前（排除）
    const body30 = await getJson(`/api/me/usage?range=last30`, cookie);
    const keys30 = body30.aggregates.map((a) => a.group);
    expect(keys30).toContain(dayKey(localToday, tz));
    expect(keys30).toContain(dayKey(localToday - 29 * DAY, tz));
    expect(keys30).not.toContain(dayKey(localToday - 30 * DAY, tz));
    // 0/13/14/29 天前 4 条在窗内；30 天前排除
    expect(body30.total).toBe(4);
  });

  it("tzOffsetMin 缺省 = UTC：与 UTC 日界一致（AC-6）", async () => {
    const userId = await setupUser("range-utc@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const localToday = localStart(0);
    // UTC 今日 03:00；UTC 昨日 23:00（本地昨日）→ today 窗口只含前者
    await seedLogs(userId, keyId, [
      { label: "utc-today", ms: localToday + 3 * 3600_000 },
      { label: "utc-yesterday", ms: localToday - 3600_000 },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=today`, cookie);
    expect(body.aggregates).toHaveLength(1);
    expect(body.aggregates[0]?.group).toBe(hourKey(localToday + 3 * 3600_000, 0));
    expect(body.total).toBe(1);
  });

  it("range 模式下 model/keyId/status 过滤仍生效（admin 额外 userId）", async () => {
    const adminId = await setupUser("range-admin@test.dev", 0, "admin");
    const userId = await setupUser("range-filter@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    await seedLogs(userId, keyId, [
      { label: "gpt-4o", ms: localToday + 2 * 3600_000, model: "gpt-4o" },
      { label: "gpt-4o-mini", ms: localToday + 3 * 3600_000, model: "gpt-4o-mini" },
    ]);

    const adminCookie = sessionCookie(await createSession(adminId));
    // admin：userId + model 过滤 + range 同窗
    const body = await getJson(
      `/api/admin/usage?range=today&tzOffsetMin=${tz}&userId=${userId}&model=gpt-4o`,
      adminCookie,
    );
    expect(body.aggregates).toHaveLength(1);
    expect(body.total).toBe(1);

    // member：keyId 过滤
    const memberCookie = sessionCookie(await createSession(userId));
    const body2 = await getJson(`/api/me/usage?range=today&tzOffsetMin=${tz}&keyId=${keyId}&model=gpt-4o-mini`, memberCookie);
    expect(body2.aggregates).toHaveLength(1);
    expect(body2.total).toBe(1);
  });

  it("tzOffsetMin 超界（1000）→ 400；非法 range → 400", async () => {
    const userId = await setupUser("range-invalid@test.dev", 10);
    const cookie = sessionCookie(await createSession(userId));
    const bad = await selfFetch("http://localhost/api/me/usage?range=today&tzOffsetMin=1000", {
      headers: { Cookie: cookie },
    });
    expect(bad.status).toBe(400);
    const badRange = await selfFetch("http://localhost/api/me/usage?range=year", {
      headers: { Cookie: cookie },
    });
    expect(badRange.status).toBe(400);
  });

  // 标题精确到维度：range 只是忽略 from/to 与**分桶类** groupBy（date/hour）；
  // groupBy=model|status 已收窄为「在该窗口内分组」（见下方同 describe 的新用例）。
  it("range 存在时 from/to 宽松忽略、groupBy=date 仍走分桶（不报错，窗口以 range 为准）", async () => {
    const userId = await setupUser("range-ignore@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    await seedLogs(userId, keyId, [{ label: "today-06", ms: localToday + 6 * 3600_000 }]);

    const cookie = sessionCookie(await createSession(userId));
    // from/to/groupBy 与 range 同传：range 优先，不 400
    const body = await getJson(
      `/api/me/usage?range=today&tzOffsetMin=${tz}&from=1999-01-01&to=1999-12-31&groupBy=date`,
      cookie,
    );
    expect(body.success).toBe(true);
    expect(body.aggregates.map((a) => a.group)).toContain(hourKey(localToday + 6 * 3600_000, tz));
    expect(body.total).toBe(1);
  });

  // ---- range × groupBy=model|status（09-14 批次 A：窗口内第二维度聚合）----
  // 上面一条用例锁的是 groupBy=date（仍是分桶）的宽松忽略；下面这组锁的是新收窄的规则：
  // model|status 不再被 range 忽略，而是在**该窗口内**分组（design §3）。

  it("range=today&groupBy=model：窗口内按模型分组，窗口外行不入组", async () => {
    const userId = await setupUser("range-model@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    await seedLogs(userId, keyId, [
      { label: "a", ms: localToday + 2 * 3600_000, model: "gpt-4o" },
      { label: "b", ms: localToday + 3 * 3600_000, model: "gpt-4o" },
      { label: "c", ms: localToday + 4 * 3600_000, model: "gpt-4o-mini" },
      { label: "d", ms: localToday - 3600_000, model: "gpt-4o" }, // 本地昨日 23:00（窗口外）
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=today&tzOffsetMin=${tz}&groupBy=model`, cookie);
    expect(body.success).toBe(true);
    // 分组键是模型名而非时间桶 —— 这条断言同时证伪「range 忽略 groupBy」的旧行为
    expect(body.aggregates.map((a) => a.group)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    const byGroup = new Map(body.aggregates.map((a) => [a.group, a]));
    expect(byGroup.get("gpt-4o")?.requests).toBe(2); // 窗口外那条不计入
    expect(byGroup.get("gpt-4o")?.tokensIn).toBe(20);
    expect(byGroup.get("gpt-4o")?.cost).toBeCloseTo(0.002, 12);
    expect(byGroup.get("gpt-4o-mini")?.requests).toBe(1);
    // groupBy 不影响明细：同窗口 3 条
    expect(body.total).toBe(3);
  });

  it("range=today&groupBy=model：窗口内无数据 → 空集（窗口外行绝不入组）", async () => {
    const userId = await setupUser("range-model-empty@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    await seedLogs(userId, keyId, [
      { label: "only-yesterday", ms: localToday - 3600_000, model: "gpt-4o" },
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=today&tzOffsetMin=${tz}&groupBy=model`, cookie);
    expect(body.aggregates).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("range=today&groupBy=status：窗口内按状态分组，四状态各一桶", async () => {
    const userId = await setupUser("range-status-group@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    const db = createDb(env);
    const seed = (hoursOffset: number, status: string, model: string | null) => ({
      userId,
      keyId,
      model,
      promptTokens: 10,
      completionTokens: 5,
      cost: status === "rejected" ? 0 : 0.001,
      status,
      createdAt: new Date(localToday + hoursOffset * 3600_000),
    });
    await db.insert(requestLogs).values([
      seed(2, "success", "gpt-4o"),
      seed(3, "error", "gpt-4o"),
      seed(4, "cached", "gpt-4o-mini"),
      seed(5, "rejected", null), // 无归属行（model IS NULL）也计入状态分组
      seed(-1, "success", "gpt-4o"), // 本地昨日（窗口外）
    ]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=today&tzOffsetMin=${tz}&groupBy=status`, cookie);
    expect(body.aggregates).toHaveLength(4);
    const byGroup = new Map(body.aggregates.map((a) => [a.group, a]));
    expect(byGroup.get("success")?.requests).toBe(1); // 窗口外那条不计入
    expect(byGroup.get("error")?.requests).toBe(1);
    expect(byGroup.get("cached")?.requests).toBe(1);
    expect(byGroup.get("rejected")?.requests).toBe(1);
    expect(byGroup.get("rejected")?.cost).toBe(0);
    expect(body.total).toBe(4);
  });

  it("range=today 不带 groupBy：仍返回小时桶（缺省路径零改动，AC8 回归锁）", async () => {
    const userId = await setupUser("range-default-bucket@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const tz = 480;
    const localToday = localStart(tz);
    await seedLogs(userId, keyId, [{ label: "t", ms: localToday + 6 * 3600_000, model: "gpt-4o" }]);

    const cookie = sessionCookie(await createSession(userId));
    const body = await getJson(`/api/me/usage?range=today&tzOffsetMin=${tz}`, cookie);
    // 对照组：同一批数据在 groupBy=model 下键是 "gpt-4o"，缺省路径下必须是小时桶键
    expect(body.aggregates.map((a) => a.group)).toEqual([hourKey(localToday + 6 * 3600_000, tz)]);
    expect(body.aggregates[0]?.group).not.toBe("gpt-4o");
  });
});

describe("GET /api/admin/usage（admin 全局）", () => {
  it("按 user/key/model/时间范围过滤；member 访问 → 403", async () => {
    const adminId = await setupUser("admin@test.dev", 0, "admin");
    const userId = await setupUser("member-c@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, cost: 0.001, latencyMs: 12, upstreamLatencyMs: 9, status: "success", createdAt: new Date("2026-08-24T03:00:00Z") },
      { userId, keyId, model: "gpt-4o", promptTokens: 30, completionTokens: 10, cost: 0.002, latencyMs: 8, upstreamLatencyMs: 6, status: "success", createdAt: new Date("2026-08-25T03:00:00Z") },
    ]);
    await consumeUsageBatch(
      makeBatch([
        { userId, keyId, model: "gpt-4o-mini", promptTokens: 100, completionTokens: 50, cost: 0.001, status: "success", ts: Date.UTC(2026, 7, 24, 3) },
        { userId, keyId, model: "gpt-4o", promptTokens: 30, completionTokens: 10, cost: 0.002, status: "success", ts: Date.UTC(2026, 7, 25, 3) },
      ]),
      env,
    );

    const adminCookie = sessionCookie(await createSession(adminId));
    const memberCookie = sessionCookie(await createSession(userId));

    // member 访问 admin 端点 → 403
    const forbidden = await selfFetch("http://localhost/api/admin/usage", {
      headers: { Cookie: memberCookie },
    });
    expect(forbidden.status).toBe(403);

    // admin：user + model 过滤
    const body = await getJson(`/api/admin/usage?userId=${userId}&model=gpt-4o-mini`, adminCookie);
    expect(body.total).toBe(1);
    expect(body.details[0]?.model).toBe("gpt-4o-mini");
    expect(body.aggregates[0]?.requests).toBe(1);
    expect(body.aggregates[0]?.tokensIn).toBe(100);
    expect(body.aggregates[0]?.cost).toBeCloseTo(0.001, 12);

    // admin：keyId + 时间范围过滤
    const body2 = await getJson(`/api/admin/usage?keyId=${keyId}&from=2026-08-25&to=2026-08-25`, adminCookie);
    expect(body2.total).toBe(1);
    expect(body2.details[0]?.model).toBe("gpt-4o");
    expect(body2.aggregates[0]?.requests).toBe(1);
    expect(body2.aggregates[0]?.tokensIn).toBe(30);

    // admin：无过滤 → 全局聚合与明细（文件内共享 D1，聚合总数 = usage_daily 全表请求数）
    const dailyAll = await db.select().from(usageDaily);
    const expectedRequests = dailyAll.reduce((sum, r) => sum + r.requests, 0);
    const body3 = await getJson("/api/admin/usage", adminCookie);
    expect(body3.aggregates[0]?.requests).toBe(expectedRequests);
  });
});

describe("保留期清理（5.4）", () => {
  it("scheduled 删除超过保留期（默认 30 天）的明细，保留近期明细", async () => {
    const userId = await setupUser("cleanup@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);

    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0, status: "success", createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0, status: "success", createdAt: new Date(Date.now() - 5 * 24 * 3600 * 1000) },
    ]);

    const event = { cron: "0 2 * * *", scheduledTime: new Date(), type: "cron" } as unknown as ScheduledEvent;
    await scheduled(event, env, {} as ExecutionContext);

    const remaining = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.userId, userId));
    expect(remaining).toHaveLength(1);
    const kept = remaining[0];
    if (!kept) {
      throw new Error("expected one remaining request log");
    }
    expect(kept.createdAt.getTime()).toBeGreaterThan(Date.now() - 30 * 24 * 3600 * 1000);
  });

  it("runRequestLogCleanup 按自定义保留期删除；parseRetentionDays 回退默认", async () => {
    expect(parseRetentionDays("45")).toBe(45);
    expect(parseRetentionDays("0")).toBe(30);
    expect(parseRetentionDays("abc")).toBe(30);
    expect(parseRetentionDays(undefined)).toBe(30);

    const userId = await setupUser("cleanup-custom@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);
    await db.insert(requestLogs).values([
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0, status: "success", createdAt: new Date(Date.now() - 20 * 24 * 3600 * 1000) },
      { userId, keyId, model: "gpt-4o", promptTokens: 1, completionTokens: 1, cost: 0, status: "success", createdAt: new Date(Date.now() - 5 * 24 * 3600 * 1000) },
    ]);

    const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const result = await runRequestLogCleanup(db, 10, silentLogger);
    // 全表清理（无 userId 过滤）：同文件 range 测试造的 13/14+ 天前行也计入 → deleted 用 ≥1；
    // 精确性由下方 remaining 断言保证（自己用户超期行被删、近期行保留）
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(false);

    const remaining = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.userId, userId));
    expect(remaining).toHaveLength(1);
  });

  it("FK 引用：被 balance_tx.ref_request_id 引用的超期明细可删（指针置 NULL，流水保留）", async () => {
    // D1 PRAGMA foreign_keys=1：直接删被引用行整批撞 FK；cleanup 应先置空追溯指针。
    const userId = await setupUser("cleanup-fk@test.dev", 10);
    const { keyId } = await setupKey(userId);
    const db = createDb(env);
    const inserted = await db
      .insert(requestLogs)
      .values({
        userId,
        keyId,
        model: "gpt-4o",
        promptTokens: 1,
        completionTokens: 1,
        cost: 0,
        status: "success",
        createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
      })
      .returning({ id: requestLogs.id });
    const logId = inserted[0]?.id;
    expect(logId).toBeDefined();
    await db.insert(balanceTx).values({
      userId,
      amount: -0.001,
      type: "usage",
      refRequestId: logId,
    });

    const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
    const result = await runRequestLogCleanup(db, 30, silentLogger);
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    const logRows = await db
      .select({ id: requestLogs.id })
      .from(requestLogs)
      .where(eq(requestLogs.id, logId ?? -1));
    expect(logRows).toHaveLength(0);
    const txRows = await db
      .select({ refRequestId: balanceTx.refRequestId })
      .from(balanceTx)
      .where(eq(balanceTx.userId, userId));
    expect(txRows).toHaveLength(1);
    expect(txRows[0]?.refRequestId).toBeNull();
  });
});
