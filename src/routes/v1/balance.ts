// 代理面余额检查中间件（M3 3.3 第三步，占位实现）。
// M3 占位：余额即硬配额（balance > 0），不足 402（OpenAI 风格错误体）。
// 真实计费（价格表 + 条件 UPDATE 原子扣费 + 流水）在 M4（4.1-4.3）完成；
// 本中间件保留为链中独立一环，M4 可注入真实语义。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../../types";

export const gatewayBalanceCheck = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const logger = c.get("logger");
    const auth = c.get("gatewayAuth");
    if (!auth) {
      await next();
      return;
    }

    if (auth.user.balance <= 0) {
      logger.warn("insufficient_balance", {
        userId: auth.user.id,
        balance: auth.user.balance,
      });
      return c.json(
        { error: { message: "Insufficient balance. Please contact the administrator to recharge." } },
        402,
      );
    }

    await next();
  };
};
