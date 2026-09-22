// Provider 管理模块路由（M3 3.2）：/api/providers/*（admin）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { listProvidersRoute } from "./procedures/list";
import { createProviderRoute } from "./procedures/create";
import { updateProviderRoute } from "./procedures/update";
import { deleteProviderRoute } from "./procedures/delete";
import { testProviderRoute } from "./procedures/test";
import { pingProviderRoute } from "./procedures/ping";

const app = new Hono<AppEnv>();

app.use("*", adminOnly());

listProvidersRoute(app); // GET /
createProviderRoute(app); // POST /
updateProviderRoute(app); // PATCH /:id
deleteProviderRoute(app); // DELETE /:id
testProviderRoute(app); // POST /:id/test（批次 N：上游协议探测）
pingProviderRoute(app); // POST /:id/ping（批次 O：origin 根联通性；先 ping 后探测由 UI 编排，本路由无门控）

export default app;
