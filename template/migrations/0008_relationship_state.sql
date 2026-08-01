CREATE TABLE relationship_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  source_conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'open_thread', 'emotional_state', 'commitment',
    'shared_moment', 'interaction_outcome'
  )),
  value TEXT NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, kind, value)
);

CREATE INDEX relationship_states_owner_active
  ON relationship_states(owner_id, status, expires_at, updated_at DESC);
