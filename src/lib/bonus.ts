// 赠金发放内核（09-16-signup-bonus-grant）：注册赠金 / 邮箱验证赠金。
//
// 三个关键设计（改动前先读，否则会破坏幂等或原子性）：
//
// 1. 为什么是 db.batch：加余额与写流水必须在同一个 D1 batch（隐式事务）里 —— 两者要么都成、
//    要么都不成。既有 adjustUserBalance（billing.ts）是「先 UPDATE 再独立 insert」两步非原子，
//    本函数刻意不复用那条路径，避免「钱加了但流水丢了」的对账缺口。
//
// 2. 为什么条件 UPDATE + onConflictDoNothing：条件 UPDATE（WHERE marker IS NULL）是原子
//    读改写，并发两次触发只有一个能命中（D1 batch 单线程执行）；onConflictDoNothing 配合
//    balance_tx_bonus_once_idx 部分唯一索引，挡住「标记列被清空后重复写流水」。
//    双重保险，不依赖应用层判重。
//
// 3. 为什么 fail-open：钩子抛异常会让 sign-up 端点返回 5xx —— 而用户行此时已落库，
//    用户会看到「注册失败但账号其实存在」，是最难排查的一类状态。赠金永远不能让注册失败。
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db";
import { balanceTx, users } from "../db/schema";
import type { Logger } from "./logger";

/** 赠金默认金额（USD）：未配置 env 时的 fallback（开箱即送）。 */
export const DEFAULT_SIGNUP_BONUS = 5;
export const DEFAULT_EMAIL_VERIFY_BONUS = 5;

/** 赠金档位（同时是 balance_tx.type 取值与部分唯一索引的判据）。 */
export type BonusType = "signup_bonus" | "email_verify_bonus";

export interface GrantBonusResult {
  /** 本次是否实际发放（false = 金额 <= 0 短路 / 该档已发过）。 */
  granted: boolean;
  /** 发放后余额；未发放为 null。 */
  balance: number | null;
}

/**
 * 解析赠金金额（USD）。语义（对应 PRD R4）：
 * - 未配置（undefined / 空白串）→ fallback（默认值，开箱即送）
 * - 配了但非有限数 / <= 0 → 0（显式关掉；非法配置 fail-safe 到「不赠」而非「照赠」）
 * - 合法正数 → 四舍五入到分（避免 REAL 浮点噪声进余额）
 *
 * 与 parseRetentionDays（cleanup.ts）同形，但**非法值回退目标不同**：保留天数非法回退到
 * 「默认天数」（无害），赠金金额涉及钱，回退方向必须是少发而非多发。
 */
export function parseBonusAmount(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed * 100) / 100;
}

/**
 * 邮箱验证功能总开关（EMAIL_VERIFICATION_ENABLED env；与 isGlobalCacheEnabled 同形）：
 * true/1/yes/on（大小写不敏感）才开启；缺省/其他值 = 关闭。
 * 关闭时 src/lib/auth.ts 的整个 emailVerification 段不配置（含 sendOnSignUp 与验证赠金钩子）。
 */
export function isEmailVerificationEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * 发放一次赠金（幂等 + 原子）。见文件头三条设计说明。
 *
 * @param amount 已解析的金额（<= 0 直接短路，不动余额、不写流水、不置标记）
 * @returns granted=true 时为本次实际发放（含发放后余额）；false 为短路或已发放过
 */
export async function grantBonusOnce(
  db: Db,
  userId: number,
  type: BonusType,
  amount: number,
  note: string,
): Promise<GrantBonusResult> {
  if (amount <= 0) {
    return { granted: false, balance: null };
  }

  const now = new Date();
  const marker =
    type === "signup_bonus"
      ? users.signupBonusGrantedAt
      : users.emailVerifyBonusGrantedAt;

  // 单次 batch（D1 隐式事务）：条件 UPDATE 与流水 insert 原子成组。
  // 条件 UPDATE 未命中（该档已发过）时 insert 仍会执行，但被部分唯一索引 +
  // onConflictDoNothing 挡下 —— 不会多写一行流水。
  const [updated] = await db.batch([
    db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${amount}`,
        ...(type === "signup_bonus"
          ? { signupBonusGrantedAt: now }
          : { emailVerifyBonusGrantedAt: now }),
        updatedAt: now,
      })
      .where(and(eq(users.id, userId), isNull(marker)))
      .returning({ balance: users.balance }),
    db
      .insert(balanceTx)
      .values({ userId, amount, type, note, createdAt: now })
      .onConflictDoNothing(),
  ]);

  const row = updated[0];
  return row ? { granted: true, balance: row.balance } : { granted: false, balance: null };
}

/**
 * 注册赠金（email/password 与 GitHub OAuth 两条路径共用；挂在 Better Auth user.create.after）。
 * fail-open：任何异常只记 error 日志，绝不抛（R10）。
 *
 * env 参数按需收窄为结构类型（同 createDb 的 { DB } 形态）：只读一个键，
 * 同时让测试可直接传入 `{ SIGNUP_BONUS_AMOUNT: "0" }` 覆盖金额分支（无需造整个 Env）。
 */
export async function grantSignupBonus(
  env: { SIGNUP_BONUS_AMOUNT?: string },
  db: Db,
  logger: Logger,
  userId: number,
): Promise<void> {
  await grantBonusFailOpen(db, logger, userId, "signup_bonus", {
    raw: env.SIGNUP_BONUS_AMOUNT,
    fallback: DEFAULT_SIGNUP_BONUS,
    note: "signup bonus",
  });
}

/**
 * 邮箱验证赠金（挂在 Better Auth emailVerification.afterEmailVerification）。
 * fail-open：同上。
 */
export async function grantEmailVerifyBonus(
  env: { EMAIL_VERIFY_BONUS_AMOUNT?: string },
  db: Db,
  logger: Logger,
  userId: number,
): Promise<void> {
  await grantBonusFailOpen(db, logger, userId, "email_verify_bonus", {
    raw: env.EMAIL_VERIFY_BONUS_AMOUNT,
    fallback: DEFAULT_EMAIL_VERIFY_BONUS,
    note: "email verified bonus",
  });
}

/** 两个包装的共用实现：解析金额 → 短路 → 发放 → 记录结果；整段 try/catch（fail-open）。 */
async function grantBonusFailOpen(
  db: Db,
  logger: Logger,
  userId: number,
  type: BonusType,
  opts: { raw: string | undefined; fallback: number; note: string },
): Promise<void> {
  try {
    const amount = parseBonusAmount(opts.raw, opts.fallback);
    if (amount <= 0) {
      // 显式关闭（金额 0/非法）不是异常：debug 级留痕即可，不刷屏
      logger.info("bonus_grant_skipped", { userId, type, amount });
      return;
    }

    const result = await grantBonusOnce(db, userId, type, amount, opts.note);
    if (result.granted) {
      logger.info("bonus_granted", { userId, type, amount, balance: result.balance });
    } else {
      logger.info("bonus_already_granted", { userId, type, amount });
    }
  } catch (error) {
    // 赠金失败绝不上抛：注册/验证主流程优先（R10 fail-open）
    logger.error("bonus_grant_failed", { userId, type, error: String(error) });
  }
}
