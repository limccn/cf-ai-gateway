// M8 全局 zod 校验错误统一（journal 延期项 1）测试：
// @hono/zod-validator 的 400 错误体（{success:false, error:{issues:[...]}}）由 src/index.ts
// 全局中间件重写为统一格式 {error:{message}}，管理面 /api/* 与代理面 /v1/* 均覆盖；
// 消息格式与 onError 的 ZodError 分支一致（Validation failed: <path>: <msg>）。
import { beforeAll, describe, expect, it } from "vitest";
import { toUnifiedErrorBody } from "../src/lib/error-format";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupKey,
  setupUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

describe("toUnifiedErrorBody（纯函数）", () => {
  it("zod v3 形态（error.issues 数组）→ {error:{message}}（path 非空）", () => {
    const out = toUnifiedErrorBody({
      success: false,
      error: {
        issues: [{ path: ["limit"], message: "Expected number, received nan" }],
      },
    });
    expect(out).toEqual({
      error: { message: "Validation failed: limit: Expected number, received nan" },
    });
  });

  it("zod v4 形态（error.message 为 issues JSON 字符串）→ 提取首个 issue", () => {
    const out = toUnifiedErrorBody({
      success: false,
      error: {
        name: "ZodError",
        message: JSON.stringify([
          {
            code: "invalid_value",
            values: ["recharge", "usage", "adjust"],
            path: ["type"],
            message: 'Invalid option: expected one of "recharge"|"usage"|"adjust"',
          },
        ]),
      },
    });
    expect(out).toEqual({
      error: {
        message:
          'Validation failed: type: Invalid option: expected one of "recharge"|"usage"|"adjust"',
      },
    });
  });

  it("zod-validator 形状 path 为空 → 用 body 占位", () => {
    const out = toUnifiedErrorBody({
      success: false,
      error: { issues: [{ path: [], message: "Invalid input" }] },
    });
    expect(out).toEqual({
      error: { message: "Validation failed: body: Invalid input" },
    });
  });

  it("非 zod-validator 形状返回 null（不重写）", () => {
    expect(toUnifiedErrorBody({ error: { message: "boom" } })).toBeNull();
    expect(toUnifiedErrorBody({ success: true, data: 1 })).toBeNull();
    expect(toUnifiedErrorBody(null)).toBeNull();
    expect(toUnifiedErrorBody("text")).toBeNull();
  });
});

describe("全局中间件：zod 校验 400 统一为 {error:{message}}", () => {
  it("管理面：/api/me/usage 非法 limit → 400 统一格式（无 issues）", async () => {
    const userId = await setupUser("zod-api@test.dev", 10);
    const cookie = sessionCookie(await createSession(userId));
    const res = await selfFetch("http://localhost/api/me/usage?limit=abc", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body["error"]?.["message"]).toContain("Validation failed");
    expect(JSON.stringify(body)).not.toContain("issues");
  });

  it("管理面：/api/me/transactions 非法 type → 400 统一格式", async () => {
    const userId = await setupUser("zod-tx@test.dev", 10);
    const cookie = sessionCookie(await createSession(userId));
    const res = await selfFetch("http://localhost/api/me/transactions?type=bogus", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body["error"]?.["message"]).toContain("Validation failed");
    expect(JSON.stringify(body)).not.toContain("issues");
  });

  it("代理面：/v1/chat/completions 缺 messages → 400 统一格式", async () => {
    const userId = await setupUser("zod-v1@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintext}`,
      },
      body: JSON.stringify({ model: "gpt-4o-mini" }), // 缺 messages
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body["error"]?.["message"]).toContain("Validation failed");
    expect(JSON.stringify(body)).not.toContain("issues");
  });
});
