ALTER TABLE assistant_query_events ADD COLUMN model_provider TEXT CHECK (
  model_provider IS NULL
  OR model_provider IN ('gemini', 'openrouter')
);
ALTER TABLE assistant_query_events ADD COLUMN model_name TEXT;
ALTER TABLE assistant_query_events ADD COLUMN provider_fallback_reason TEXT;
ALTER TABLE assistant_query_events ADD COLUMN provider_attempts_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_model_provider
  ON assistant_query_events (model_provider, created_at);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_provider_fallback_reason
  ON assistant_query_events (provider_fallback_reason, created_at);