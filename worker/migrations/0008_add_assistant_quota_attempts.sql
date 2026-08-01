ALTER TABLE assistant_usage_counters ADD COLUMN quota_attempts INTEGER NOT NULL DEFAULT 0;

UPDATE assistant_usage_counters
SET quota_attempts = model_calls
WHERE quota_attempts = 0 AND model_calls > 0;
