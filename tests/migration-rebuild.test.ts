// 重建式迁移的数据保全（09-22-seed-users-dev-only，AC-F9 / 决策 D-F1）。
//
// 这是本仓**第一条重建式迁移**（drizzle 生成的 `__new_*` → INSERT SELECT → DROP → RENAME，
// 见 drizzle/0011_lame_silver_fox.sql：SQLite 无法直接放开 NOT NULL，只能重建表）。
// 重建是唯一能**静默吃数据**的迁移形态 —— `INSERT ... SELECT` 写漏一列、或顺序颠倒，
// 应用「成功」、测试全绿，而生产数据已经丢了。故用专项用例把两件事同时锁死：
//   ① 既有行**原样存活**（含 created_by 原值）；
//   ② 新能力**真的生效**（NULL 签发者从被拒变为可插）—— ② 必须有 ① 的"拒"作为对照，
//      否则「本来就能插 NULL」的实现会平凡满足它。
//
// 做法：先只应用 0011 **之前**的迁移（模拟"生产已运行到 0010、表里已有数据"），插入夹具，
// 再应用 0011，最后断言。applyD1Migrations 按 d1_migrations 表跳过已应用项，故可分两次调用。
import { applyD1Migrations, env } from "cloudflare:test";
import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { inviteCodes, users } from "../src/db/schema";

/** 本用例锚定的迁移。加新迁移后这里会红 —— 提示把锚点换成"最新的那条重建式迁移"。 */
const TARGET_MIGRATION = "0011_lame_silver_fox.sql";

/** 展开错误链（drizzle 包装错误 → D1 原始错误），用于断言底层列约束文案。 */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth += 1) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(" | ");
}

describe("重建式迁移（invite_codes.created_by 放开 NOT NULL）", () => {
  it("既有行与索引原样存活，且 NULL 签发者由被拒变为可插", async () => {
    const all = env.TEST_MIGRATIONS;
    const target = all[all.length - 1];
    expect(target?.name).toBe(TARGET_MIGRATION);
    const prior = all.slice(0, -1);

    // ---------- ① 跑到 0010，造"生产已有数据"的夹具 ----------
    await applyD1Migrations(env.DB, prior);
    const db = createDb(env);
    const issuerRows = await db
      .insert(users)
      .values({ email: "mig-issuer@test.dev", name: "Issuer", role: "admin", balance: 0 })
      .returning();
    const issuer = issuerRows[0];
    if (!issuer) {
      throw new Error("setup: issuer 未建成");
    }
    // 夹具时间戳取整到秒：`mode: "timestamp"` 的列存的是**秒**，毫秒在写入时即被截断
    // （与本迁移无关；不取整会让下面的"原值不变"断言拿毫秒去比秒）。
    const toSeconds = (ms: number): Date => new Date(Math.floor(ms / 1000) * 1000);
    const expiresAt = toSeconds(Date.now() + 24 * 3600 * 1000);
    const consumedAt = toSeconds(Date.now());
    await db.insert(inviteCodes).values([
      { code: "MIGKEEP001", createdBy: issuer.id, expiresAt, usedAt: consumedAt },
      { code: "MIGKEEP002", createdBy: issuer.id, expiresAt },
    ]);

    // 对照：0010 的 schema 下 created_by 是 NOT NULL，插入 NULL 必须被**数据库**拒绝。
    // （drizzle 类型上此时已允许 null —— 拒绝来自列约束，正是本迁移要放开的那一条。）
    // 穿透错误链：drizzle 抛的是包装错误（"Failed query: ..."），列约束原文在 cause 里。
    let beforeMigration: unknown;
    try {
      await db.insert(inviteCodes).values({ code: "MIGNULL000", createdBy: null, expiresAt });
    } catch (err) {
      beforeMigration = err;
    }
    expect(errorChain(beforeMigration)).toMatch(/NOT NULL/i);

    // ---------- ② 应用目标迁移（重建 invite_codes）----------
    await applyD1Migrations(env.DB, [target]);

    // ---------- ③ 既有行存活，且 created_by / used_at 原值不变 ----------
    const rows = await db.select().from(inviteCodes).orderBy(asc(inviteCodes.id));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.has("MIGKEEP001")).toBe(true);
    expect(byCode.has("MIGKEEP002")).toBe(true);
    expect(byCode.get("MIGKEEP001")?.createdBy).toBe(issuer.id);
    expect(byCode.get("MIGKEEP002")?.createdBy).toBe(issuer.id);
    expect(byCode.get("MIGKEEP001")?.usedAt?.getTime()).toBe(consumedAt.getTime());
    expect(byCode.get("MIGKEEP002")?.usedAt).toBeNull();
    expect(byCode.get("MIGKEEP001")?.expiresAt.getTime()).toBe(expiresAt.getTime());

    // ---------- ④ 新能力生效：NULL 可插（③ 的对照）----------
    const inserted = await db
      .insert(inviteCodes)
      .values({ code: "MIGNULL001", createdBy: null, expiresAt })
      .returning();
    expect(inserted[0]?.createdBy).toBeNull();

    // ---------- ⑤ 重建没有丢结构：两个索引 + 一条指向 users 的外键仍在 ----------
    // （唯一索引在重建里是 DROP 之后**重建**的 —— 漏掉它不会有任何功能用例变红。）
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invite_codes'",
    ).all<{ name: string }>();
    const indexNames = indexes.results.map((r) => r.name).sort();
    expect(indexNames).toContain("invite_codes_created_by_idx");
    expect(indexNames).toContain("invite_codes_code_idx");
    expect(indexNames).toContain("invite_codes_code_unique");

    const fks = await env.DB.prepare("PRAGMA foreign_key_list(invite_codes)").all<{
      table: string;
      from: string;
    }>();
    expect(fks.results).toHaveLength(1);
    expect(fks.results[0]?.table).toBe("users");
    expect(fks.results[0]?.from).toBe("created_by");
  });
});
