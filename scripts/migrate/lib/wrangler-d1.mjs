// 移管工具链共用的 wrangler/D1 调用面（09-21-seed-migration-tooling）。
//
// 抽出来的唯一理由是**这三个脚本必须对「库名 × target 参数」和「一条语句一次调用」给出
// 完全相同的答案**：这两件事都是"错一个字符就静默打到别的库/静默拿到非数组"的类型，
// 三份拷贝必然漂移（本仓库已有 perf-stream「按 cwd 定 wrangler 目标库」的错位前车之鉴）。
//
// target 只有三种，都在这里：
//   staging → cf-ai-gateway-db-staging --env staging --remote
//   prod    → cf-ai-gateway-db            （顶层段就是生产）--remote
//   local   → cf-ai-gateway-db --local    （本机 miniflare 夹具；--persist-to 隔离目录）
//
// **导出侧只允许 staging/prod**（写入口都不提供 local），校验侧三种都开放（校验是只读的）。
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WRANGLER_JS = fileURLToPath(
  new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

/** 目标真源：库名 + 目标参数。local 的库名与 prod 同名，靠 `--local` 分道。 */
export const TARGETS = {
  staging: { db: "cf-ai-gateway-db-staging", args: ["--env", "staging", "--remote"] },
  prod: { db: "cf-ai-gateway-db", args: ["--remote"] },
  local: { db: "cf-ai-gateway-db", args: ["--local"] },
};

/** 一次 wrangler 调用的公共参数（永远显式 --config：vite 插件生成的 dist 产物丢 [env.*] 段）。 */
export function targetArgs(target, persistTo) {
  const spec = TARGETS[target];
  if (!spec) {
    throw new Error(`unknown target ${target}（只接受 ${Object.keys(TARGETS).join(" / ")}）`);
  }
  const args = [spec.db, ...spec.args, "--config", "wrangler.toml"];
  if (persistTo !== undefined) {
    if (target !== "local") {
      throw new Error(`--persist-to 只对 local 有效（收到 target=${target}）`);
    }
    args.push("--persist-to", persistTo);
  }
  return args;
}

/**
 * 一条语句一次调用的只读查询（runbook R-D11 的取证纪律写成断言）。
 * 多语句时 wrangler 的 `--json` 输出不是数组，`j[0].results` 会失败 —— 与其事后对着
 * `undefined.forEach` 猜，不如在这里直接拦住。
 */
export function d1Query(sql, { target, persistTo }) {
  const body = sql.trim().replace(/;\s*$/, "");
  if (body.includes(";")) {
    throw new Error(`一次调用只允许一条语句（多语句的 --json 不是数组）：\n${sql}`);
  }
  const stdout = execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", ...targetArgs(target, persistTo), "--command", sql, "--json"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const results = parsed[0]?.results;
  if (!Array.isArray(results)) {
    throw new Error(`wrangler 输出里没有 results 数组（多语句或出错）：${stdout.slice(0, 400)}`);
  }
  return results;
}
