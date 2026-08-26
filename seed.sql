-- Seed: default model price table (USD per 1M tokens).
-- Idempotent: INSERT OR IGNORE on unique model name -> safe to re-run (npm run db:seed).
-- 注意：这些是默认价格，admin 可在管理后台覆盖（M6）。
INSERT OR IGNORE INTO models (model, input_price, output_price, created_at, updated_at) VALUES
  -- OpenAI
  ('gpt-4o',                      2.50,  10.00, unixepoch(), unixepoch()),
  ('gpt-4o-mini',                 0.15,   0.60, unixepoch(), unixepoch()),
  ('gpt-4.1',                     2.00,   8.00, unixepoch(), unixepoch()),
  ('gpt-4.1-mini',                0.40,   1.60, unixepoch(), unixepoch()),
  ('o3-mini',                     1.10,   4.40, unixepoch(), unixepoch()),
  ('text-embedding-3-small',      0.02,   0.02, unixepoch(), unixepoch()),
  ('text-embedding-3-large',      0.13,   0.13, unixepoch(), unixepoch()),
  -- DeepSeek
  ('deepseek-chat',               0.27,   1.10, unixepoch(), unixepoch()),
  ('deepseek-reasoner',           0.55,   2.19, unixepoch(), unixepoch()),
  -- Qwen (Alibaba)
  ('qwen-turbo',                  0.30,   0.60, unixepoch(), unixepoch()),
  ('qwen-plus',                   0.80,   2.00, unixepoch(), unixepoch()),
  ('qwen-max',                    2.40,   9.60, unixepoch(), unixepoch()),
  ('qwen-long',                   0.20,   0.20, unixepoch(), unixepoch()),
  -- Moonshot (Kimi)
  ('moonshot-v1-8k',              1.70,   4.20, unixepoch(), unixepoch()),
  -- Anthropic
  ('claude-3-5-sonnet-20241022',  3.00,  15.00, unixepoch(), unixepoch()),
  ('claude-3-5-haiku-20241022',   0.80,   4.00, unixepoch(), unixepoch()),
  ('claude-3-opus-20240229',     15.00,  75.00, unixepoch(), unixepoch()),
  ('claude-sonnet-4-20250514',    3.00,  15.00, unixepoch(), unixepoch()),
  ('claude-opus-4-20250514',     15.00,  75.00, unixepoch(), unixepoch());
