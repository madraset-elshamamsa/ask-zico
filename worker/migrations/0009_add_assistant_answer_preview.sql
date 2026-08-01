ALTER TABLE assistant_query_events ADD COLUMN answer_preview TEXT;
ALTER TABLE assistant_query_events ADD COLUMN answer_preview_truncated INTEGER NOT NULL DEFAULT 0 CHECK (answer_preview_truncated IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_answer_preview_created_at
  ON assistant_query_events (created_at)
  WHERE answer_preview IS NOT NULL;