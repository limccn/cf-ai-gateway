// 批次 U（D29/D30）：GET /api/invites/validate 注册前预校验端点契约（AC51）。
//
// 覆盖：
//   1) 未登录 200 + `{success:true, valid:boolean}`（注册页此时无会话 —— 端点必须挂在
//      requireSession 之前，本用例正是那条挂载顺序的判据）；
//   2) 有效 / 已用 / 过期 / 不存在 / 空码 / 缺参 的真值；
//   3) **不消费码**（调用后 usedAt 仍 NULL 且可重复查询 —— 建号前烧码 = 注册失败白丢一码）；
//   4) 大小写/空白归一后命中（与服务端消费侧同口径）；
//   5) **不细分失效原因**（三个失效码的响应体逐字节相同 —— 不给枚举者存活性预言机）。
//
// 限流：本文件**不带** cf-connecting-ip（helpers 的 selfFetch 不注入）⇒ 走 auth-rate-limit
// 的「缺 IP 放行」分支，与 AC5 同一实测结论；路径白名单本身由
// tests/auth-rate-limit.test.ts 的路径表单测钉住（D30）。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { inviteCodes } from "../src/db/schema";
import { applyMigrations, selfFetch, setupUser } from "./helpers";

/** 打预校验端点；`code === undefined` = **缺参**（URL 不带 ?code=）。 */
function validate(code?: string): Promise<Response> {
  const url =
    code === undefined
      ? "http://localhost/api/invites/validate"
      : `http://localhost/api/invites/validate?code=${encodeURIComponent(code)}`;
  return selfFetch(url);
}

async function readJson(res: Response): Promise<{ success: true; valid: boolean }> {
  return (await res.json()) as { success: true; valid: boolean };
}

async function insertInvite(
  code: string,
  createdBy: number,
  expiresAt: Date = new Date(Date.now() + 24 * 3600 * 1000),
): Promise<void> {
  const db = createDb(env);
  await db.insert(inviteCodes).values({ code, createdBy, expiresAt });
}

async function markUsed(code: string): Promise<void> {
  const db = createDb(env);
  await db.update(inviteCodes).set({ usedAt: new Date() }).where(eq(inviteCodes.code, code));
}

async function usedAt(code: string): Promise<Date | null> {
  const db = createDb(env);
  const row = await db.query.inviteCodes.findFirst({
    where: eq(inviteCodes.code, code),
    columns: { usedAt: true },
  });
  return row?.usedAt ?? null;
}

let ADMIN_ID = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("iv-admin@test.dev", 0, "admin");
});

describe("GET /api/invites/validate（公开预校验，AC51）", () => {
  it("未登录 200：{success:true, valid:true}（挂载在 requireSession 之前）", async () => {
    await insertInvite("IVALID01", ADMIN_ID);
    const res = await validate("IVALID01");
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ success: true, valid: true });
  });

  it("有效码调用**不消费**（usedAt 仍 NULL）且重复查询幂等", async () => {
    await insertInvite("IVALID02", ADMIN_ID);
    const first = await readJson(await validate("IVALID02"));
    const second = await readJson(await validate("IVALID02"));
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    expect(await usedAt("IVALID02")).toBeNull();
  });

  it("大小写/空白归一后命中（trim+大写，与消费侧同口径），仍不消费", async () => {
    await insertInvite("IVALID03", ADMIN_ID);
    const res = await validate("  ivAlid03  ");
    expect(res.status).toBe(200);
    expect((await readJson(res)).valid).toBe(true);
    expect(await usedAt("IVALID03")).toBeNull();
  });

  it("已用码 → valid:false", async () => {
    await insertInvite("IVUSED01", ADMIN_ID);
    await markUsed("IVUSED01");
    const res = await validate("IVUSED01");
    expect(res.status).toBe(200);
    expect((await readJson(res)).valid).toBe(false);
  });

  it("过期码 → valid:false", async () => {
    await insertInvite("IVEXP001", ADMIN_ID, new Date(Date.now() - 1000));
    const res = await validate("IVEXP001");
    expect(res.status).toBe(200);
    expect((await readJson(res)).valid).toBe(false);
  });

  it("不存在 / 空码 / 缺参 → 一律 200 + {success:true, valid:false}（无 400/404 分支）", async () => {
    for (const code of ["NOSUCHCODE", "", undefined] as const) {
      const res = await validate(code);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ success: true, valid: false });
    }
  });

  it("不细分失效原因：已用 / 过期 / 不存在三者响应体**逐字节相同**", async () => {
    await insertInvite("IVREASON1", ADMIN_ID);
    await markUsed("IVREASON1");
    await insertInvite("IVREASON2", ADMIN_ID, new Date(Date.now() - 1000));
    const bodies = await Promise.all(
      ["IVREASON1", "IVREASON2", "IVNOSUCH1"].map(async (code) => (await validate(code)).text()),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe('{"success":true,"valid":false}');
  });
});
