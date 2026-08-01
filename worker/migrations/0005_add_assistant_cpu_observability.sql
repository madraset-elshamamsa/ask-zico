ALTER TABLE assistant_query_events ADD COLUMN worker_cpu_ms REAL;
ALTER TABLE assistant_query_events ADD COLUMN worker_cpu_over_budget INTEGER NOT NULL DEFAULT 0 CHECK (worker_cpu_over_budget IN (0, 1));
ALTER TABLE assistant_query_events ADD COLUMN worker_cpu_phases_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_worker_cpu_over_budget
  ON assistant_query_events (worker_cpu_over_budget, created_at);
