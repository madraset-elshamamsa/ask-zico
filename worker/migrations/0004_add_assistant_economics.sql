CREATE TABLE IF NOT EXISTS assistant_usage_counters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL CHECK (period_type IN ('day', 'month')),
  period_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'device', 'user')),
  usage_key TEXT NOT NULL,
  model_calls INTEGER NOT NULL DEFAULT 0,
  fallback_calls INTEGER NOT NULL DEFAULT 0,
  retrieval_calls INTEGER NOT NULL DEFAULT 0,
  vectorize_queries INTEGER NOT NULL DEFAULT 0,
  vectorize_dimensions INTEGER NOT NULL DEFAULT 0,
  kv_reads_estimated INTEGER NOT NULL DEFAULT 0,
  d1_writes_estimated INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (period_type, period_key, scope, usage_key)
);

CREATE INDEX IF NOT EXISTS idx_assistant_usage_counters_period
  ON assistant_usage_counters (period_type, period_key);

CREATE INDEX IF NOT EXISTS idx_assistant_usage_counters_scope
  ON assistant_usage_counters (scope, usage_key);

CREATE TABLE IF NOT EXISTS assistant_budget_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL CHECK (period_type IN ('day', 'month')),
  period_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  UNIQUE (period_type, period_key, metric, threshold)
);

CREATE INDEX IF NOT EXISTS idx_assistant_budget_alerts_period
  ON assistant_budget_alerts (period_type, period_key);

ALTER TABLE assistant_query_events ADD COLUMN response_kind TEXT CHECK (
  response_kind IS NULL
  OR response_kind IN ('model', 'fallback', 'retrieval_only')
);
ALTER TABLE assistant_query_events ADD COLUMN quota_block_reason TEXT;
ALTER TABLE assistant_query_events ADD COLUMN estimated_model_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE assistant_query_events ADD COLUMN compact_context INTEGER NOT NULL DEFAULT 0 CHECK (compact_context IN (0, 1));
ALTER TABLE assistant_query_events ADD COLUMN fallback_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_response_kind
  ON assistant_query_events (response_kind);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_quota_block_reason
  ON assistant_query_events (quota_block_reason);
