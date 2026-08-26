// M8 计费流水端点单测（journal 延期项 3）：
// GET /api/me/transactions（分页 + type/时间过滤 + 401/400）、
// GET /api/admin/transactions（admin 全局 + userId 过滤、member 403）。
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { balanceTx } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

interface TxItem {
  id: number;
  type: string;
  amount: number;
  note: string | null;
  refRequestId: number | null;
  createdAt: string;
}

interface TxBody {
  success: boolean;
  items: TxItem[];
  total: number;
  limit: number;
  offset: number;
}

async function getJson(path: string, cookie: string): Promise<TxBody> {
  const res = await selfFetch(`http://localhost${path}`, {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as TxBody;
}

/** 直接落 balance_tx 流水（审计轨迹数据，测试驱动）。 */
async function insertTx(
  userId: number,
  rows: Array<{
    type: string;
    amount: number;
    note?: string | null;
    createdAt?: Date;
  }>,
): Promise<void> {
  const db = createDb(env);
  await db.insert(balanceTx).values(
    rows.map((row) => ({
      userId,
      type: row.type,
      amount: row.amount,
      note: row.note ?? null,
      createdAt: row.createdAt ?? new Date(),
    })),
  );
}

beforeAll(async () => {
  await applyMigrations();
});

describe("GET /api/me/transactions（member 自己）", () => {
  it("未登录 → 401", async () => {
    const res = await selfFetch("http://localhost/api/me/transactions");
    expect(res.status).toBe(401);
  });

  it("分页：limit/offset + id 倒序（最新在前）", async () => {
    const userId = await setupUser("tx-page@test.dev", 10);
    await insertTx(userId, [
      { type: "adjust", amount: 50, note: "credit-1" },
      { type: "usage", amount: -1, note: "usage-1" },
      { type: "adjust", amount: -10, note: "debit-1" },
      { type: "usage", amount: -2, note: "usage-2" },
      { type: "adjust", amount: 100, note: "credit-2" },
    ]);
    const cookie = sessionCookie(await createSession(userId));

    const first = await getJson("/api/me/transactions?limit=2&offset=0", cookie);
    expect(first.total).toBe(5);
    expect(first.limit).toBe(2);
    expect(first.items).toHaveLength(2);
    // id 倒序：最新插入的 credit-2 在最前
    expect(first.items[0]?.note).toBe("credit-2");
    expect(first.items[1]?.note).toBe("usage-2");
    expect(first.items[0]?.id).toBeGreaterThan(first.items[1]?.id ?? 0);

    const last = await getJson("/api/me/transactions?limit=2&offset=4", cookie);
    expect(last.items).toHaveLength(1);
    expect(last.items[0]?.note).toBe("credit-1");
  });

  it("type 过滤：只返回该类型的流水", async () => {
    const userId = await setupUser("tx-type@test.dev", 10);
    await insertTx(userId, [
      { type: "adjust", amount: 50 },
      { type: "usage", amount: -3 },
      { type: "adjust", amount: -7 },
    ]);
    const cookie = sessionCookie(await createSession(userId));

    const body = await getJson("/api/me/transactions?type=adjust", cookie);
    expect(body.total).toBe(2);
    expect(body.items.every((item) => item.type === "adjust")).toBe(true);

    const usageBody = await getJson("/api/me/transactions?type=usage", cookie);
    expect(usageBody.total).toBe(1);
    expect(usageBody.items[0]?.amount).toBe(-3);
  });

  it("时间过滤：from/to（YYYY-MM-DD，含当日，UTC 日界）", async () => {
    const userId = await setupUser("tx-range@test.dev", 10);
    await insertTx(userId, [
      { type: "adjust", amount: 50, createdAt: new Date("2026-08-24T03:00:00Z") },
      { type: "usage", amount: -1, createdAt: new Date("2026-08-25T03:00:00Z") },
      { type: "adjust", amount: 10, createdAt: new Date("2026-08-25T23:59:00Z") },
    ]);
    const cookie = sessionCookie(await createSession(userId));

    const body = await getJson("/api/me/transactions?from=2026-08-25&to=2026-08-25", cookie);
    expect(body.total).toBe(2);
    expect(body.items.every((item) => item.note === null)).toBe(true);

    const all = await getJson("/api/me/transactions?from=2026-08-24&to=2026-08-25", cookie);
    expect(all.total).toBe(3);
  });

  it("非法 type → 400（统一 {error:{message}} 格式）", async () => {
    const userId = await setupUser("tx-badtype@test.dev", 10);
    const cookie = sessionCookie(await createSession(userId));
    const res = await selfFetch("http://localhost/api/me/transactions?type=refund", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body["error"]?.["message"]).toContain("Validation failed");
  });
});

describe("GET /api/admin/transactions（admin 全局）", () => {
  it("member → 403；未登录 → 401", async () => {
    const memberId = await setupUser("tx-member@test.dev", 0);
    const memberCookie = sessionCookie(await createSession(memberId));
    const forbidden = await selfFetch("http://localhost/api/admin/transactions", {
      headers: { Cookie: memberCookie },
    });
    expect(forbidden.status).toBe(403);

    const anonymous = await selfFetch("http://localhost/api/admin/transactions");
    expect(anonymous.status).toBe(401);
  });

  it("admin：无过滤返回全部；userId 过滤只返回该用户", async () => {
    const adminId = await setupUser("tx-admin@test.dev", 0, "admin");
    const userA = await setupUser("tx-a@test.dev", 10);
    const userB = await setupUser("tx-b@test.dev", 10);
    await insertTx(userA, [
      { type: "adjust", amount: 100, note: "for-a" },
      { type: "usage", amount: -5, note: "a-usage" },
    ]);
    await insertTx(userB, [{ type: "adjust", amount: 200, note: "for-b" }]);
    const cookie = sessionCookie(await createSession(adminId));

    // 无过滤：全库流水（文件内各用例共享 D1，从库中取实际总数作期望）
    const db = createDb(env);
    const allRows = await db.select().from(balanceTx);
    const all = await getJson("/api/admin/transactions", cookie);
    expect(all.total).toBe(allRows.length);

    const filtered = await getJson(`/api/admin/transactions?userId=${userA}`, cookie);
    expect(filtered.total).toBe(2);
    expect(filtered.items.every((item) => item.note?.startsWith("for-a") || item.note === "a-usage")).toBe(true);
  });
});
