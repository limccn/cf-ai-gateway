// Better Auth 实例工厂（M2 2.1）。
// 设计要点：
// - 每次请求由 c.env + D1 创建实例（spec environment.md：env 禁止全局缓存）。
// - D1 adapter 通过 drizzleAdapter + schema 映射，将 Better Auth 的
//   user/session/account/verification 模型映射到应用表（users/sessions/accounts/verifications）。
// - advanced.database.generateId = "serial"：用户/会话 id 由 D1 自增生成（与 M1 users.id 整数自增兼容）。
// - user.additionalFields：role/status/balance 注册为只读附加字段（input: false，客户端不可写），
//   随 session 用户对象下发；inviteCode 仅允许注册时提交（input: true），写入前由 create.before 钩子剥离。
// - user.validateUserInfo：注册/登录准入门（邀请码校验 + GitHub 白名单），
//   通过 source.method/action 区分 email-password 注册与 GitHub OAuth 流程。
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { consumeInviteCode, validateInviteCode } from "./invites";
import { logger } from "./logger";

// F2（安全评审）：先消费后建号 —— create.before 钩子内消费邀请码（乐观锁条件 UPDATE），
// 消费失败 return false 阻止建号，关闭「两并发同码注册都通过校验、一码两用」的重放窗口。
// 权衡：before 消费后若 Better Auth 内部建号失败 → 码被烧（一次性码语义，管理员可补发）。
import { isEmailAllowed } from "./github-whitelist";
import { isSeedEmail, parseSeedUsers } from "./seed-users";

const INVITE_CODE_REQUIRED = "INVITE_CODE_REQUIRED";
const INVITE_CODE_INVALID = "INVITE_CODE_INVALID";
const GITHUB_EMAIL_NOT_ALLOWED = "GITHUB_EMAIL_NOT_ALLOWED";

// 无显式返回类型标注：让 TS 推断 Auth<Options>，使 session.user 携带 additionalFields（role/status/balance）。
export function createAuth(env: Env, db: Db) {
  const baseUrl = env.BETTER_AUTH_URL;
  const baseOrigin = new URL(baseUrl).origin;

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: baseUrl,
    trustedOrigins: [baseOrigin],

    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),

    advanced: {
      // users.id 为 INTEGER 自增主键：由数据库生成数字 id（Better Auth 内部转字符串处理）
      database: { generateId: "serial" },
    },

    user: {
      additionalFields: {
        // 应用自有字段：只读（input: false），由服务端维护
        role: { type: "string", required: true, defaultValue: "member", input: false },
        status: { type: "string", required: true, defaultValue: "active", input: false },
        balance: { type: "number", required: true, defaultValue: 0, input: false },
        // 注册时客户端提交邀请码；create.before 钩子校验通过后剥离，不落库
        inviteCode: { type: "string", input: true },
      },
      // 准入门：email-password 注册需邀请码；GitHub OAuth 需白名单邮箱
      validateUserInfo: async ({ user, source }) => {
        if (source.method === "email-password" && source.action === "create-user") {
          // dev-only 种子逃生口：仅当 SEED_USERS 配置且邮箱在种子列表内时放行（绕过邀请码）。
          // 生产/测试未配置 SEED_USERS → 本分支永不进入；配置了即视为本地调试场景。
          const seedSpecs = parseSeedUsers(env.SEED_USERS);
          const email = typeof user.email === "string" ? user.email : "";
          if (isSeedEmail(seedSpecs, email)) {
            return;
          }
          const inviteCode = readInviteCode(user);
          if (inviteCode === "") {
            return { error: INVITE_CODE_REQUIRED, errorDescription: "Invite code is required for email/password signup" };
          }
          // 只校验不消费（F2：一次性码在 create.before 钩子消费，见文件头权衡注释）
          const ok = await validateInviteCode(db, inviteCode);
          if (!ok) {
            return { error: INVITE_CODE_INVALID, errorDescription: "Invalid, used or expired invite code" };
          }
          return;
        }
        if (source.method === "oauth" && source.oauth?.providerId === "github") {
          const email = typeof user.email === "string" ? user.email : "";
          if (!isEmailAllowed(env.GITHUB_ALLOWED_EMAILS, email)) {
            return { error: GITHUB_EMAIL_NOT_ALLOWED, errorDescription: "Your GitHub email is not on the allowed list" };
          }
        }
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },

    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },

    databaseHooks: {
      user: {
        create: {
          // F2：先消费后建号 —— 消费成功才放行建号（乐观锁保证并发下唯一赢家），
          // 消费失败（无效/已用/过期/并发被抢先）return false 阻止建号，关闭重放窗口。
          // 剥离 inviteCode：邀请码为一次性凭证，不随用户记录持久化。
          before: async (user) => {
            if ("inviteCode" in user) {
              const code = String(user.inviteCode ?? "").trim();
              if (code === "") {
                // 空串 = 未提供：dev seed 路径（validateUserInfo 白名单放行，不消费）；
                // 生产无 SEED_USERS 入口，普通注册已在 validateUserInfo 拦 INVITE_CODE_REQUIRED。
                return { data: { inviteCode: undefined } };
              }
              const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
              if (email === "") {
                return false;
              }
              const ok = await consumeInviteCode(db, code);
              if (!ok) {
                // 模块级 logger：钩子为非请求上下文（无 requestId）
                logger.warn("invite_code_consume_failed", { email });
                return false;
              }
              return { data: { inviteCode: undefined } };
            }
            return undefined;
          },
        },
      },
      session: {
        create: {
          // 停用用户（status='disabled'）禁止创建新会话（登录）
          before: async (session) => {
            const userId = Number(session.userId);
            const user = await db.query.users.findFirst({
              where: eq(schema.users.id, userId),
            });
            if (user && user.status === "disabled") {
              return false;
            }
            return undefined;
          },
        },
      },
    },

    // 内部日志关闭：事件由本应用结构化日志（requestContext logger）记录
    logger: { disabled: true },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

/** 从 validateUserInfo 的 user 数据中安全读取邀请码（trim + 大写归一）。 */
function readInviteCode(user: Record<string, unknown>): string {
  const raw = user.inviteCode;
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().toUpperCase();
}
