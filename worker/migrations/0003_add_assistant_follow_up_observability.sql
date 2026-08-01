ALTER TABLE assistant_query_events ADD COLUMN is_follow_up INTEGER NOT NULL DEFAULT 0 CHECK (is_follow_up IN (0, 1));
ALTER TABLE assistant_query_events ADD COLUMN parent_message_id TEXT;
ALTER TABLE assistant_query_events ADD COLUMN follow_up_cited_chunk_ids_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_is_follow_up
  ON assistant_query_events (is_follow_up);

CREATE INDEX IF NOT EXISTS idx_assistant_query_events_parent_message_id
  ON assistant_query_events (parent_message_id);
