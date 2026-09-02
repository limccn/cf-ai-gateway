// 代理面余额检查中间件（M3 3.3 第三步，占位实现）。
// D2 债务模型（09-01-review U3 确认）：扣费为**无条件递减**（消费者），余额可为负
// （= 债务，充值自愈）；本中间件只拦截**已负债**（balance < 0）——余额 0 允许进入
// （消费超支 → 负余额债务，由下一次请求的预检拦截）。并发突发超支窗口由债务兜底，
// 不再白送（延迟计费的队列积压不再造成无上限免单）。
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

    if (auth.user.balance < 0) {
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
