// GET /api/providers/presets 的路由级测试（09-28 批次 5 复核补）。
//
// 为什么补：批次 5 交付时该端点零路由级覆盖。adminOnly 门的「删除」变异会被同门线的
// 既有测试锁住（provider-ping.test.ts / provider-test-probe.test.ts 的 member 403 走
// 同一行 app.use），但「app.use 行挪到 GET /presets 注册之后」的**顺序**变异没有任何
// 测试会红 —— Hono 的 use 只作用于其后注册的路由（models/router.ts 2026-09-23 实测过
// 同形态事故）。本文件锁三件事：
//   ① admin 200 + items 与档案常量逐项一致（端点返回的就是 PROVIDER_PRESETS 本体）；
//   ② member 403 —— 锁定 use 行在 /presets 注册**之前**的顺序；
//   ③ 未登录 401 —— requireSession（index.ts 挂 /api/*）先于模块路由，两层都在场。
import { beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../src/providers/presets";
import {
  applyMigrations,
  clearKv,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

describe("GET /api/providers/presets（批次 5：preset 档案常量端点）", () => {
  it("admin：200，items 与档案常量逐项一致", async () => {
    const adminId = await setupUser("presets-route-admin@test.dev", 0, "admin");
    const cookie = sessionCookie(await createSession(adminId));
    const res = await selfFetch("http://localhost/api/providers/presets", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; items: unknown };
    expect(body.success).toBe(true);
    expect(body.items).toEqual(PROVIDER_PRESETS as unknown);
  });

  it("member：403（锁定 adminOnly use 行在该路由注册之前——顺序变异在这里红）", async () => {
    const memberId = await setupUser("presets-route-member@test.dev", 0, "member");
    const cookie = sessionCookie(await createSession(memberId));
    const res = await selfFetch("http://localhost/api/providers/presets", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("未登录：401（requireSession 层，先于 adminOnly）", async () => {
    const res = await selfFetch("http://localhost/api/providers/presets");
    expect(res.status).toBe(401);
  });
});
