// Provider 管理模块路由（M3 3.2）：/api/providers/*（admin）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { listProvidersRoute } from "./procedures/list";
import { listProviderPresetsRoute } from "./procedures/presets";
import { createProviderRoute } from "./procedures/create";
import { updateProviderRoute } from "./procedures/update";
import { deleteProviderRoute } from "./procedures/delete";
import { testProviderRoute } from "./procedures/test";
import { declareEndpointRoute } from "./procedures/declare-endpoint";
import { pingProviderRoute } from "./procedures/ping";

const app = new Hono<AppEnv>();

app.use("*", adminOnly());

listProvidersRoute(app); // GET /
listProviderPresetsRoute(app); // GET /presets（批次 5：preset 档案常量表，建档预填；design §2.4）
createProviderRoute(app); // POST /
updateProviderRoute(app); // PATCH /:id
deleteProviderRoute(app); // DELETE /:id
testProviderRoute(app); // POST /:id/test（批次 N：上游协议探测；批次 6 改逐面探测，只回显无副作用）
declareEndpointRoute(app); // POST /:id/declare-endpoint（批次 6 G2：「声明此端点」人工回写，只写 protocols 子对象）
pingProviderRoute(app); // POST /:id/ping（批次 O：origin 根联通性；先 ping 后探测由 UI 编排，本路由无门控）

export default app;
