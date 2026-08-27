// 测试辅助：D1/KV 准备（迁移、用户、Key、Provider、价格）与断言查询。
import { applyD1Migrations, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import {
  apiKeys,
  balanceTx,
  models,
  providers,
  requestLogs,
  sessions,
  users,
} from "../src/db/schema";
import { encryptSecret, hashToken } from "../src/lib/security";

/** 通过同一 isolate 内主 worker 的 default export 发请求（v0.22 中弃用的 SELF 在此环境不可用）。 */
export function selfFetch(input: string, init?: RequestInit): Promise<Response> {
  const app = exports.default as { fetch(request: Request): Promise<Response> };
  return app.fetch(new Request(input, init));
}

/** 应用 drizzle 迁移建表（miniflare 测试 D1 为空库）。 */
export async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

/** 清空 KV（防跨文件/用例残留计数器与缓存）。 */
export async function clearKv(): Promise<void> {
  const listed = await env.CACHE_KV.list();
  await Promise.all(listed.keys.map((k) => env.CACHE_KV.delete(k.name)));
}

export async function setupUser(
  email: string,
  balance: number,
  role: "admin" | "member" = "member",
): Promise<number> {
  const db = createDb(env);
  const inserted = await db
    .insert(users)
    .values({ email, name: email.split("@")[0] ?? email, role, balance })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test user");
  }
  return row.id;
}

export interface SetupKeyOptions {
  qpsLimit?: number;
  cacheEnabled?: boolean;
  cacheTtl?: number;
}

export async function setupKey(
  userId: number,
  opts: SetupKeyOptions = {},
): Promise<{ keyId: number; plaintext: string }> {
  const db = createDb(env);
  const plaintext = `gw_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const hash = await hashToken(plaintext);
  const inserted = await db
    .insert(apiKeys)
    .values({
      userId,
      name: "test-key",
      hash,
      prefix: plaintext.slice(0, 8),
      qpsLimit: opts.qpsLimit ?? 60,
      cacheEnabled: opts.cacheEnabled ?? false,
      cacheTtl: opts.cacheTtl ?? 3600,
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test api key");
  }
  return { keyId: row.id, plaintext };
}

/** 注册一个 openai 类型 Provider（base_url 不可达，仅用于模型路由解析）。同名 Provider 幂等（providers.name 无唯一约束，先查后改）。返回 provider id。 */
export async function setupProviderWithModel(model: string): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, "mock-provider"),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(providers)
      .set({
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnc,
        models: JSON.stringify({ [model]: model }),
      })
      .where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({
      name: "mock-provider",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnc,
      models: JSON.stringify({ [model]: model }),
    })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test provider");
  }
  return row.id;
}

/** 价格表 upsert（同名模型幂等）。5 列对应 M9 分层：short/long 输入、cached 输入、short/long 输出。 */
export async function setupPrice(
  model: string,
  inputPriceShort: number,
  inputPriceLong: number,
  inputPriceCached: number,
  outputPriceShort: number,
  outputPriceLong: number,
): Promise<void> {
  const db = createDb(env);
  await db
    .insert(models)
    .values({
      model,
      inputPriceShort,
      inputPriceLong,
      inputPriceCached,
      outputPriceShort,
      outputPriceLong,
    })
    .onConflictDoUpdate({
      target: models.model,
      set: {
        inputPriceShort,
        inputPriceLong,
        inputPriceCached,
        outputPriceShort,
        outputPriceLong,
      },
    });
}

export async function getBalance(userId: number): Promise<number> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true },
  });
  if (!row) {
    throw new Error("test user not found");
  }
  return row.balance;
}

export async function countTxByType(userId: number, type: string): Promise<number> {
  const db = createDb(env);
  const rows = await db
    .select()
    .from(balanceTx)
    .where(and(eq(balanceTx.userId, userId), eq(balanceTx.type, type)));
  return rows.length;
}

export async function latestLogStatus(userId: number): Promise<string | null> {
  const db = createDb(env);
  const rows = await db
    .select({ status: requestLogs.status, cost: requestLogs.cost })
    .from(requestLogs)
    .where(eq(requestLogs.userId, userId))
    .orderBy(desc(requestLogs.id))
    .limit(1);
  const row = rows[0];
  return row ? row.status : null;
}

/**
 * 创建 Better Auth 会话（直接落库；M5 usage 报表测试用）。
 * 本版本 better-auth 会话 token 明文入库（createSession 不哈希，getSession 直接按 token 查询）。
 * 返回签名 Cookie 值（格式 `${token}.${hmac-sha256-base64}`，URL 编码），配合 sessionCookie 使用。
 */
export async function createSession(userId: number): Promise<string> {
  const db = createDb(env);
  const plain = `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.insert(sessions).values({
    token: plain,
    userId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(plain),
  );
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${plain}.${signatureB64}`);
}

/** 组装 Better Auth 会话 Cookie 头值。 */
export function sessionCookie(cookieValue: string): string {
  return `better-auth.session_token=${cookieValue}`;
}
