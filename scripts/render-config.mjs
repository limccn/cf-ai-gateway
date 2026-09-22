#!/usr/bin/env node
// 渲染入口（package.json 的 `render:config`）—— 串联两个生成器：
//   1. scripts/render-wrangler-config.mjs  模板 + 两个值文件 → wrangler.toml（段感知，一次含两环境）
//   2. scripts/render-modelcaps.mjs        seed.sql + modelcap 常数 → src/generated/modelcaps.ts
//
// **为什么要这一层**：npm 把 `npm run <script> -- <args>` 的额外参数追加到脚本命令串的**末尾**。
// 原先 `render:config` 形如 `A && B`，参数全部落到 B（render-modelcaps）上 —— 于是文档里长期存在的
// `npm run render:config -- --env staging` **从未真正把 --env 传进渲染脚本**（npm 还会好心警告
// "Unknown cli config"）。收敛成单条命令后，参数必定到达本文件，再原样转发给第一段，
// 由它统一判定（`--env` 已随段感知改造移除，传入即 fail-fast）。
//
// 用法：
//   npm run render:config              # 渲染 wrangler.toml + 档位表
//   npm run render:config -- --check   # 只校验（不写任何文件，跳过档位表生成）
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const check = args.includes("--check");

function run(script, scriptArgs) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...scriptArgs], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[render-config] ✗ 无法执行 ${script}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

// 参数原样转发：render-wrangler-config 自己负责 `--env` / 未知参数的 fail-fast。
const wranglerStatus = run("scripts/render-wrangler-config.mjs", args);
if (wranglerStatus !== 0) process.exit(wranglerStatus);

// --check 语义是"仅校验、不写文件"：档位表生成会写 src/generated/modelcaps.ts，故跳过。
if (!check) {
  const capsStatus = run("scripts/render-modelcaps.mjs", []);
  if (capsStatus !== 0) process.exit(capsStatus);
}
