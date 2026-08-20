ALTER TABLE assistant_query_events ADD COLUMN ui_locale TEXT CHECK (ui_locale IN ('ar', 'en'));
ALTER TABLE assistant_query_events ADD COLUMN detected_language TEXT CHECK (detected_language IN ('ar', 'en', 'unsupported'));
ALTER TABLE assistant_query_events ADD COLUMN answer_language TEXT CHECK (answer_language IN ('ar', 'en'));
ALTER TABLE assistant_query_events ADD COLUMN translation_status TEXT CHECK (translation_status IN ('not_needed', 'translated', 'failed', 'missing_config'));
ALTER TABLE assistant_query_events ADD COLUMN translation_latency_ms INTEGER;
