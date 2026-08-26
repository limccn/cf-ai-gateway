// 价格表管理模块路由（M4 4.1，admin）：/api/models。
// requireSession 已在 index.ts 对 /api/* 全局挂载；本模块再挂 adminOnly（R4.2 admin 管理价格表）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { listModelsRoute } from "./procedures/list";
import { createModelRoute } from "./procedures/create";
import { updateModelRoute } from "./procedures/update";
import { deleteModelRoute } from "./procedures/delete";

const app = new Hono<AppEnv>();

app.use("*", adminOnly());

listModelsRoute(app); // GET /
createModelRoute(app); // POST /
updateModelRoute(app); // PATCH /:id
deleteModelRoute(app); // DELETE /:id

export default app;
