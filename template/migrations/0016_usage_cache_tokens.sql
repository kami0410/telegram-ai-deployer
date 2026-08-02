ALTER TABLE usage_daily
  ADD COLUMN prompt_cache_hit_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_daily
  ADD COLUMN prompt_cache_miss_tokens INTEGER NOT NULL DEFAULT 0;
