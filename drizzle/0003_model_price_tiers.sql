-- 0003: models 表价格列升级为分层/缓存五价（M9 模型定价升级）
-- - input_price / output_price 改名为 *_short 档
-- - 新增 input_price_long / input_price_cached / output_price_long
-- - 既有行回填：long = short（未分层语义），cached = short × 25%（推算兜底值，seed 会重新覆盖）
ALTER TABLE models RENAME COLUMN input_price TO input_price_short;
ALTER TABLE models RENAME COLUMN output_price TO output_price_short;
ALTER TABLE models ADD COLUMN input_price_long REAL NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN input_price_cached REAL NOT NULL DEFAULT 0;
ALTER TABLE models ADD COLUMN output_price_long REAL NOT NULL DEFAULT 0;
UPDATE models SET input_price_long = input_price_short,
                  input_price_cached = ROUND(input_price_short * 0.25, 6),
                  output_price_long = output_price_short;
