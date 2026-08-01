CREATE TABLE relationship_state_controls (
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  relationship_state_id INTEGER NOT NULL REFERENCES relationship_states(id) ON DELETE CASCADE,
  control TEXT NOT NULL CHECK (control IN ('normal', 'pinned', 'ignored')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, relationship_state_id)
);

CREATE TABLE interaction_reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  period_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, period_key)
);

CREATE INDEX interaction_reflections_owner_updated
  ON interaction_reflections(owner_id, updated_at DESC);
