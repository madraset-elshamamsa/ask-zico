CREATE TABLE IF NOT EXISTS assistant_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  confidence TEXT CHECK (
    confidence IS NULL
    OR confidence IN ('retrieval_only', 'low', 'medium', 'high')
  ),
  doc_ids_json TEXT NOT NULL DEFAULT '[]',
  chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  citation_urls_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_feedback_message_id
  ON assistant_feedback (message_id);

CREATE INDEX IF NOT EXISTS idx_assistant_feedback_rating
  ON assistant_feedback (rating);

CREATE INDEX IF NOT EXISTS idx_assistant_feedback_created_at
  ON assistant_feedback (created_at);
