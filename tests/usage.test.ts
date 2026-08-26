// M5 用量统计单测：
// - 5.2 Queues 聚合 upsert（分组求和 / 幂等重投 / 非法消息跳过）
// - 5.3 报表 API（member 自己 / admin 全局过滤 / 越权 403 / 聚合与明细核对一致）
// - 5.4 保留期清理（scheduled cron 逻辑 + parseRetentionDays）
import { env } from "cloudflare:test";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { requestLogs, usageDaily } from "../src/db/schema";
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

const QUEUE_NAME = "usage-aggregation";

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
    expect(result.deleted).toBe(1);
    expect(result.truncated).toBe(false);

    const remaining = await db
      .select()
      .from(requestLogs)
      .where(eq(requestLogs.userId, userId));
    expect(remaining).toHaveLength(1);
  });
});
