-- Seed: 默认模型价格表（USD / 每百万 tokens）—— 全量同步脚本。
-- 价格来源：OpenRouter API 实时抓取（openrouter.ai/api/v1/models）+ 厂商官方价目核实
--   （详见 .trellis/tasks/08-26-model-pricing-tiers/research/models-pricing.md）。
-- 列：input_price_short / input_price_long / input_price_cached / output_price_short / output_price_long
--   max_output_tokens：模型级输出上限（tokens，NULL = 不限制；proxy 层 clamp 防慢模型撞上游超时）。
-- 分层规则（M9）：单次请求未缓存输入 tokens > 128,000 时输入与输出均取 long 档，否则 short 档。
--   ⚠ 官方阈值与网关固定 128K 不一致的模型（gpt-5.x=272K / claude-sonnet-4.5=200K），
--     错位区间按网关 128K 判定计费（128K~官方阈值间按 long 档多收），属已确认决策。
-- 缓存价 = 官方公布的缓存命中输入价（OpenAI/Anthropic 10%、DeepSeek/Qwen 20% 量级）。
-- 幂等语义（2026-09-11 起）：** 全量替换 ** —— 先清空 models 再按本清单重灌，
--   本文件即权威全量状态；同步 = 对任意环境（local/stg/prod）直接执行本文件。
--   ⚠ 会清除 admin 后台自定义模型及手工调整的价格/输出上限，执行前请确认。
--   D1 批量执行为原子事务（一条失败全部回滚），不会出现中间空表窗口。

DELETE FROM models;

INSERT INTO models
  (model, input_price_short, input_price_long, input_price_cached, output_price_short, output_price_long, max_output_tokens, created_at, updated_at)
VALUES
  -- OpenAI（官方分层阈值 272K > 网关 128K；128K~272K 区间按 long 档计，见头部说明）
  ('gpt-5.6-sol',    2.00,   4.00,   0.20,   10.00,  15.00,  16384, unixepoch(), unixepoch()),
  ('gpt-5.6-codex',  2.00,   4.00,   0.20,   10.00,  15.00,  16384, unixepoch(), unixepoch()),
  ('gpt-5.6-terra',  2.00,   4.00,   0.20,   12.00,  18.00,  16384, unixepoch(), unixepoch()),
  ('gpt-5.6-luna',   0.20,   0.40,   0.02,    1.20,   1.80,  16384, unixepoch(), unixepoch()),
  ('gpt-6-astra',    10.00,  15.00,  1.50,   60.00,  90.00,  16384, unixepoch(), unixepoch()),
  -- Anthropic（除 claude-sonnet-4.5 外官方未分层；缓存价 = 输入价 10%）
  ('claude-fable-5.1',    20.00, 20.00, 2.00, 50.00, 50.00, 16384, unixepoch(), unixepoch()),
  ('claude-fable-5',      10.00, 10.00, 1.00, 50.00, 50.00, 16384, unixepoch(), unixepoch()),
  ('claude-opus-5',       5.00,  5.00, 0.50, 25.00, 25.00, 16384, unixepoch(), unixepoch()),
  ('claude-opus-4.8',     5.00,  5.00, 0.50, 25.00, 25.00, 16384, unixepoch(), unixepoch()),
  ('claude-opus-4.5',     5.00,  5.00, 0.50, 25.00, 25.00, 16384, unixepoch(), unixepoch()),
  ('claude-sonnet-5',     2.00,  2.00, 0.20, 10.00, 10.00, 16384, unixepoch(), unixepoch()),
  ('claude-sonnet-4.6',   3.00,  3.00, 0.30, 15.00, 15.00, 16384, unixepoch(), unixepoch()),
  ('claude-sonnet-4.5',   3.00,  6.00, 0.30, 15.00, 22.50, 16384, unixepoch(), unixepoch()), -- 官方阈值 200K，网关 128K 判档
  ('claude-haiku-4.5',    1.00,  1.00, 0.10,  5.00,  5.00,  16384, unixepoch(), unixepoch()),
  -- DeepSeek（缓存价 ≈ 输入价 20%；2026-08-26 决策取最新快照价，OpenRouter 裸 slug 指向旧快照）
  ('deepseek-v4.1-flash', 0.040, 0.040, 0.008,  0.080,  0.080,  65536, unixepoch(), unixepoch()),
  ('deepseek-v4-pro',     1.122, 1.122, 0.0374, 3.366,  3.366,  16384, unixepoch(), unixepoch()),
  -- placeholder: qwen3.8-flash 未上架任何市场源（OpenRouter 全量 417 模型 + 阿里官方页 404，2026-08-26），
  -- 价取同族 qwen3.7-flash 占位，在架后请 admin 覆盖
  ('qwen3.8-flash', 0.03,   0.03,   0.006,  0.13,   0.13,   32768, unixepoch(), unixepoch()),
  -- placeholder: qwen3.8-27b 未上架任何市场源（同上），价取 qwen3.7-plus 占位，在架后请 admin 覆盖
  ('qwen3.8-27b',   0.32,   0.32,   0.064,  1.28,   1.28,   65536, unixepoch(), unixepoch()),
  ('qwen3.8-max',   2.00,   2.00,   0.25,   6.00,   6.00,   16384, unixepoch(), unixepoch()),
  -- Zhipu（GLM，官方未分层；缓存价 ≈ 输入价 18.6%）
  ('glm-5.3',       1.19,   1.19,   0.221,  3.74,   3.74,   32768, unixepoch(), unixepoch()),
  ('glm-5.3-flash', 0.040,  0.040,  0.008,  0.080,  0.080,  65536, unixepoch(), unixepoch()),
  -- MIMO（官方未分层；缓存价 ≈ 输入价 20%）
  ('mimo-v2.5',    0.10,   0.10,   0.02,   0.30,   0.30,   32768, unixepoch(), unixepoch()),
  ('mimo-v2.5-pro',0.10,  0.10,   0.02,   0.30,   0.30,   32768, unixepoch(), unixepoch()),
  -- Hy3（官方未分层；缓存价 ≈ 输入价 20%）
  ('hy3',          0.10,   0.10,   0.02,   0.30,   0.30,   65536, unixepoch(), unixepoch()),
  ('hy4-preview',  0.32,   0.32,   0.064,  1.28,   1.28,   16384,  unixepoch(), unixepoch()),
  -- kimi
  ('kimi-k2.6',    0.040,  0.040,  0.008,  0.080,  0.080,  65536, unixepoch(), unixepoch()),
  ('kimi-k3',      1.19,   1.19,   0.221,  3.74,   3.74,   16384, unixepoch(), unixepoch()),
  -- minimax
  ('minimax-m3',   0.10,   0.10,   0.02,   0.30,   0.30,   16384, unixepoch(), unixepoch());
