// Provider 管理模块路由（M3 3.2）：/api/providers/*（admin）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { listProvidersRoute } from "./procedures/list";
import { createProviderRoute } from "./procedures/create";
import { updateProviderRoute } from "./procedures/update";
import { deleteProviderRoute } from "./procedures/delete";
import { testProviderRoute } from "./procedures/test";

const app = new Hono<AppEnv>();

app.use("*", adminOnly());

listProvidersRoute(app); // GET /
createProviderRoute(app); // POST /
updateProviderRoute(app); // PATCH /:id
deleteProviderRoute(app); // DELETE /:id
testProviderRoute(app); // POST /:id/test（批次 N：上游协议探测）

export default app;
