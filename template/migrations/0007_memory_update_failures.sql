CREATE TABLE IF NOT EXISTS memory_update_failures (
  owner_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 1,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, conversation_id)
);

