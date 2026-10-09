// 密钥管理模块路由（M3 3.1）：/api/keys/*。
// requireSession 已在 index.ts 对 /api/* 全局挂载；member(自己)/admin(全部) 在 procedure 内校验。
//
// **不提供 DELETE**（2026-09-18 用户裁决）：Key 与系统绑定过深（request_logs.key_id、
// usage_daily.key_id 均在复合主键/外键里，ON DELETE no action），删除会带来意外问题，
// 故全局取消删除能力，只保留**不可恢复的 revoke**（POST /:id/revoke）。
// 原 DELETE /:id 对任何被使用过的 Key 都返回 500（外键约束），是缺陷而非特性。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { listKeysRoute } from "./procedures/list";
import { createKeyRoute } from "./procedures/create";
import { updateKeyRoute } from "./procedures/update";
import { revokeKeyRoute } from "./procedures/revoke";

const app = new Hono<AppEnv>();

listKeysRoute(app); // GET /
createKeyRoute(app); // POST /
updateKeyRoute(app); // PATCH /:id
revokeKeyRoute(app); // POST /:id/revoke

export default app;
