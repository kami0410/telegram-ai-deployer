CREATE UNIQUE INDEX IF NOT EXISTS memory_episodes_source_content_unique
  ON memory_episodes(owner_id, source_message_id, content);

CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_candidate_unique
  ON memory_conflicts(owner_id, existing_fact_id, source_message_id, candidate_fact_value);

ALTER TABLE reminders ADD COLUMN claimed_at INTEGER;
ALTER TABLE reminders ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
