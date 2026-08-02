CREATE TABLE proactive_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('send', 'skip', 'defer')),
  reason_code TEXT NOT NULL,
  topic_key TEXT,
  source_entity_kind TEXT,
  source_entity_id INTEGER,
  novelty_score INTEGER NOT NULL,
  unanswered_count INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  sent_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  outcome TEXT CHECK (outcome IN ('replied', 'corrected', 'ignored')),
  outcome_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX proactive_decisions_owner_created
  ON proactive_decisions(owner_id, created_at DESC, id DESC);
CREATE INDEX proactive_decisions_pending_outcome
  ON proactive_decisions(owner_id, decision, outcome, scheduled_at DESC);
