// GET /api/me/profile —— 当前 member 自己的账号资料（name/email/emailVerified + 验证开关）。
// userId 取自会话（/me 路径天然 self；admin 也看自己的资料）。
//
// 数据取**服务端最新值**（单表主键查询），不从 session 透传：session 可能因 staleTime 滞后，
// 且 SessionUser 不含 emailVerified 与开关。返回值只暴露这四个字段 —— role/balance/status
// 等应用自有字段不下发（本端点无此需求，少暴露一分是一分）。
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { users } from "../../../db/schema";
import { isEmailVerificationEnabled } from "../../../lib/bonus";
import type { ProfileOutput } from "../types";

export function getProfileRoute(app: Hono<AppEnv>): void {
  app.get("/me/profile", async (c) => {
    const logger = c.get("logger");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底（同 me-transactions）
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = createDb(c.env);

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true, email: true, emailVerified: true },
    });
    if (!user) {
      // 会话有效但用户行已消失（理论不可达）：显式 404 而非返回空壳资料
      throw new HTTPException(404, { message: "User not found" });
    }

    // 开关值来自 isEmailVerificationEnabled（唯一解析点，与 src/lib/auth.ts 门控同一函数）；
    // 本文件不得写 env.X === "true" —— 否则两处解析漂移会让「有开关无入口/有入口无开关」。
    const emailVerificationEnabled = isEmailVerificationEnabled(
      c.env.EMAIL_VERIFICATION_ENABLED,
    );

    logger.info("me_profile_reported", {
      userId,
      emailVerified: user.emailVerified,
      emailVerificationEnabled,
    });

    const output: ProfileOutput = {
      success: true,
      profile: {
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        emailVerificationEnabled,
      },
    };
    return c.json(output);
  });
}
