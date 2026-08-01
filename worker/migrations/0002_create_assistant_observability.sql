CREATE TABLE IF NOT EXISTS assistant_query_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  conversation_id TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  page_url TEXT,
  page_title TEXT,
  locale TEXT,
  query_text TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  answered INTEGER NOT NULL CHECK (answered IN (0, 1)),
  retrieved_references INTEGER NOT NULL CHECK (retrieved_references IN (0, 1)),
  cited_references INTEGER NOT NULL CHECK (cited_references IN (0, 1)),
  confidence TEXT CHECK (
    confidence IS NULL
    OR confidence IN ('retrieval_only', 'low', 'medium', 'high')
  ),
  answer_mode TEXT CHECK (
    answer_mode IS NULL
    OR answer_mode IN ('grounded', 'handoff')
  ),
  answer_failure_reason TEXT,
  retrieval_mode TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  semantic_domains_json TEXT NOT NULL DEFAULT '[]',
  doc_ids_json TEXT NOT NULL DEFAULT '[]',
  chunk_ids_json TEXT NOT NULL DEFAULT '[]',
  citation_urls_json TEXT NOT NULL DEFAULT '[]',
  rating TEXT CHECK (
    rating IS NULL
    OR rating IN ('up', 'down')
  ),
  feedback_created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_created_at
  ON assistant_query_events (created_at);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_user_id
  ON assistant_query_events (user_id);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_answered
  ON assistant_query_events (answered);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_rating
  ON assistant_query_events (rating);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_confidence
  ON assistant_query_events (confidence);
