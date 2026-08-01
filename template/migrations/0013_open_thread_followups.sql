ALTER TABLE relationship_states ADD COLUMN follow_up_after INTEGER;
ALTER TABLE relationship_states ADD COLUMN followed_up_at INTEGER;
ALTER TABLE relationship_states ADD COLUMN follow_up_attempts INTEGER NOT NULL DEFAULT 0;

UPDATE relationship_states
SET follow_up_after = updated_at + 21600
WHERE kind = 'open_thread' AND follow_up_after IS NULL;

CREATE INDEX relationship_states_open_thread_followup
  ON relationship_states(owner_id, kind, status, followed_up_at, follow_up_after);
