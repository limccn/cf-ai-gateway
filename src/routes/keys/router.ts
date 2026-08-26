// 密钥管理模块路由（M3 3.1）：/api/keys/*。
// requireSession 已在 index.ts 对 /api/* 全局挂载；member(自己)/admin(全部) 在 procedure 内校验。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { listKeysRoute } from "./procedures/list";
import { createKeyRoute } from "./procedures/create";
import { updateKeyRoute } from "./procedures/update";
import { revokeKeyRoute } from "./procedures/revoke";
import { deleteKeyRoute } from "./procedures/delete";

const app = new Hono<AppEnv>();

listKeysRoute(app); // GET /
createKeyRoute(app); // POST /
updateKeyRoute(app); // PATCH /:id
revokeKeyRoute(app); // POST /:id/revoke
deleteKeyRoute(app); // DELETE /:id

export default app;
