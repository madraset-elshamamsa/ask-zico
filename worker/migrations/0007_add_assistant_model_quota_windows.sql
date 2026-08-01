CREATE TABLE IF NOT EXISTS assistant_model_quota_windows (
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('rpm', 'day')),
  period_key TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, model_name, period_type, period_key)
);

CREATE INDEX IF NOT EXISTS idx_assistant_model_quota_windows_period
  ON assistant_model_quota_windows (provider, period_type, period_key);

CREATE INDEX IF NOT EXISTS idx_assistant_model_quota_windows_model
  ON assistant_model_quota_windows (provider, model_name, period_type, period_key);
