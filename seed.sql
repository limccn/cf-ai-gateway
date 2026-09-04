-- Seed: 默认模型价格表（USD / 每百万 tokens），2026-08-26 调研快照。
-- 价格来源：OpenRouter API 实时抓取（openrouter.ai/api/v1/models）+ 厂商官方价目核实
--   （详见 .trellis/tasks/08-26-model-pricing-tiers/research/models-pricing.md）。
-- 列：input_price_short / input_price_long / input_price_cached / output_price_short / output_price_long
-- 分层规则（M9）：单次请求未缓存输入 tokens > 128,000 时输入与输出均取 long 档，否则 short 档。
--   ⚠ 官方阈值与网关固定 128K 不一致的模型（gpt-5.x=272K / claude-sonnet-4.5=200K / qwen3.7-plus=256K），
--     错位区间按网关 128K 判定计费（128K~官方阈值间按 long 档多收），属已确认决策。
-- 缓存价 = 官方公布的缓存命中输入价（OpenAI/Anthropic 10%、DeepSeek/Qwen 20% 量级）。
-- DeepSeek 取最新快照价（flash-0731 / pro-0813，2026-08-26 已确认；OpenRouter 裸 slug 指向旧 0423 快照）。
-- 幂等：INSERT OR IGNORE on unique model name + 显式删除旧模型清单（仅删已知旧 seed 模型，
--   不误伤 admin 后台自定义模型）；安全重跑（npm run db:seed）。

-- 删除旧模型（2026-08-26 决策：价格表全量替换为最新模型）
DELETE FROM models WHERE model IN (
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini',
  'text-embedding-3-small', 'text-embedding-3-large',
  'deepseek-chat', 'deepseek-reasoner',
  'qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long',
  'moonshot-v1-8k',
  'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229',
  'claude-sonnet-4-20250514', 'claude-opus-4-20250514'
);

INSERT OR IGNORE INTO models
  (model, input_price_short, input_price_long, input_price_cached, output_price_short, output_price_long, created_at, updated_at)
VALUES
  -- OpenAI（官方分层阈值 272K > 网关 128K；128K~272K 区间按 long 档计，见头部说明）
  ('gpt-5.6-sol',    2.00,   4.00,   0.20,   10.00,  15.00,  unixepoch(), unixepoch()),
  ('gpt-5.6-codex',  2.00,   4.00,   0.20,   10.00,  15.00,  unixepoch(), unixepoch()),
  ('gpt-5.6-terra',  2.00,   4.00,   0.20,   12.00,  18.00,  unixepoch(), unixepoch()),
  ('gpt-5.6-luna',   0.20,   0.40,   0.02,    1.20,   1.80,  unixepoch(), unixepoch()),
  ('gpt-5.5',        5.00,  10.00,   0.50,   30.00,  45.00,  unixepoch(), unixepoch()),
  -- Anthropic（除 claude-sonnet-4.5 外官方未分层；缓存价 = 输入价 10%）
  ('claude-fable-5',     10.00, 10.00, 1.00, 50.00, 50.00, unixepoch(), unixepoch()),
  ('claude-opus-5',       5.00,  5.00, 0.50, 25.00, 25.00, unixepoch(), unixepoch()),
  ('claude-opus-4.8',     5.00,  5.00, 0.50, 25.00, 25.00, unixepoch(), unixepoch()),
  ('claude-opus-4.5',     5.00,  5.00, 0.50, 25.00, 25.00, unixepoch(), unixepoch()),
  ('claude-sonnet-5',     2.00,  2.00, 0.20, 10.00, 10.00, unixepoch(), unixepoch()),
  ('claude-sonnet-4.6',   3.00,  3.00, 0.30, 15.00, 15.00, unixepoch(), unixepoch()),
  ('claude-sonnet-4.5',   3.00,  6.00, 0.30, 15.00, 22.50, unixepoch(), unixepoch()), -- 官方阈值 200K，网关 128K 判档
  ('claude-haiku-4.5',    1.00,  1.00, 0.10,  5.00,  5.00, unixepoch(), unixepoch()),
  -- DeepSeek（2026-08-26 决策：最新快照价 flash-0731 / pro-0813；缓存价 ≈ 输入价 20%）
  ('deepseek-v4-flash', 0.040, 0.040, 0.008,  0.080,  0.080, unixepoch(), unixepoch()),
  ('deepseek-v4-flash-vision-exp', 0.040, 0.040, 0.008,  0.080,  0.080, unixepoch(), unixepoch()),
  ('deepseek-v4-pro',   1.122, 1.122, 0.0374, 3.366,  3.366, unixepoch(), unixepoch()),
  -- Qwen（qwen3.7-flash 官方三档 32K/256K 收敛为两档：≤128K $0.03 / >128K $0.10；
  --   ⚠ 官方 >256K 输入 $0.20 / 输出 $0.80，网关按 $0.10/$0.40 少收，属已确认决策）
  ('qwen3.7-flash', 0.03,   0.10,   0.006,  0.13,   0.40,   unixepoch(), unixepoch()),
  ('qwen3.7-plus',  0.32,   0.96,   0.064,  1.28,   3.84,   unixepoch(), unixepoch()), -- 官方阈值 256K，网关 128K 判档
  ('qwen3.7-max',   1.475,  1.475,  0.295,  4.425,  4.425,  unixepoch(), unixepoch()),
  -- placeholder: qwen3.8-flash 未上架任何市场源（OpenRouter 全量 417 模型 + 阿里官方页 404，2026-08-26），
  -- 价取同族 qwen3.7-flash 占位，在架后请 admin 覆盖（M6）
  ('qwen3.8-flash', 0.03,   0.03,   0.006,  0.13,   0.13,   unixepoch(), unixepoch()),
  -- placeholder: qwen3.8-plus 未上架任何市场源（同上），价取 qwen3.7-plus 占位，在架后请 admin 覆盖
  ('qwen3.8-plus',  0.32,   0.32,   0.064,  1.28,   1.28,   unixepoch(), unixepoch()),
  ('qwen3.8-max',   2.00,   2.00,   0.25,   6.00,   6.00,   unixepoch(), unixepoch()),
  -- Zhipu（GLM 5.2，官方未分层；缓存价 ≈ 输入价 18.6%）
  ('glm-5.2',       1.19,   1.19,   0.221,  3.74,   3.74,   unixepoch(), unixepoch()),
  ('glm-5.3',       1.19,   1.19,   0.221,  3.74,   3.74,   unixepoch(), unixepoch()),
  ('glm-5.3-flash', 0.040,  0.040,  0.008,  0.080,  0.080,  unixepoch(), unixepoch()),
  -- Moonshot（官方未分层；缓存价 ≈ 输入价 20%）
  ('moonshot-v1-8k', 0.10,  0.10,  0.02,  0.30,  0.30,  unixepoch(), unixepoch()),
  -- MIMO（官方未分层；缓存价 ≈ 输入价 20%）
  ('mimo-v2.5',    0.10,   0.10,   0.02,   0.30,   0.30,   unixepoch(), unixepoch()),
  ('mimo-v2.5-pro',0.10,  0.10,   0.02,   0.30,   0.30,   unixepoch(), unixepoch()),
  -- Hy3（官方未分层；缓存价 ≈ 输入价 20%）
  ('hy3',          0.10,   0.10,   0.02,   0.30,   0.30,   unixepoch(), unixepoch()),
  ('hy4-preview',  0.32,   0.32,   0.064,  1.28,   1.28,   unixepoch(), unixepoch()),
  -- kimi
  ('kimi-k2.6',    0.040,  0.040,  0.008,  0.080,  0.080,  unixepoch(), unixepoch()),
  ('kimi-k3',      1.19,   1.19,   0.221,  3.74,   3.74,   unixepoch(), unixepoch()),
  -- minimax
  ('minimax-m3',   0.10,   0.10,   0.02,   0.30,   0.30,   unixepoch(), unixepoch());