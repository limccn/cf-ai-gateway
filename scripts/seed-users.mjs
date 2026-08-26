// 触发本地测试用户初始化：POST http://localhost:5173/api/seed/users
// 前提：npm run dev 运行中，且 .dev.vars 配置了 SEED_USERS（见 .dev.vars.example / docs/DEPLOY.md §5.4）。
// 种子数据由服务端从 env 读取，本脚本不接触密码 —— 生产环境未配 SEED_USERS 时端点 404。
const BASE = process.env.SEED_BASE_URL ?? "http://localhost:5173";
const url = `${BASE.replace(/\/$/, "")}/api/seed/users`;

const res = await fetch(url, { method: "POST" });
const body = await res.json().catch(() => null);

console.log(`POST ${url} -> ${res.status}`);
console.log(JSON.stringify(body, null, 2));

if (res.status !== 200) {
  process.exit(1);
}
const summary = body;
if (Array.isArray(summary.failed) && summary.failed.length > 0) {
  console.error(`\n⚠  ${summary.failed.length} 个用户初始化失败，见上方 failed 明细`);
  process.exit(1);
}