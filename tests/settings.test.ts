// M8 /api/admin/settings 单测（journal 延期项 2）：admin 只读端点返回当前生效的
// 运行时默认配置（缓存 TTL / 限流窗口 / 明细保留天数，与代码常量一致）；
// 未登录 401、member 403（PRD AC6 权限隔离）。
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

interface SettingsBody {
  success: boolean;
  settings: {
    cacheTtlSeconds: number;
    rateLimitWindowSeconds: number;
    requestLogRetentionDays: number;
  };
}

describe("GET /api/admin/settings", () => {
  it("未登录 → 401", async () => {
    const res = await selfFetch("http://localhost/api/admin/settings");
    expect(res.status).toBe(401);
  });

  it("member → 403", async () => {
    const memberId = await setupUser("settings-member@test.dev", 0);
    const cookie = sessionCookie(await createSession(memberId));
    const res = await selfFetch("http://localhost/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("admin → 200，返回 3 项运行时默认配置（与代码常量一致）", async () => {
    const adminId = await setupUser("settings-admin@test.dev", 0, "admin");
    const cookie = sessionCookie(await createSession(adminId));
    const res = await selfFetch("http://localhost/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.success).toBe(true);
    expect(body.settings.cacheTtlSeconds).toBe(3600); // api_keys.cache_ttl schema 默认
    expect(body.settings.rateLimitWindowSeconds).toBe(60); // rate-limit.ts WINDOW_SECONDS
    expect(body.settings.requestLogRetentionDays).toBe(30); // cleanup.ts 默认（测试 env 无覆盖）
  });
});
