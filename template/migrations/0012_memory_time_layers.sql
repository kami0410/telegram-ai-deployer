CREATE TABLE memory_time_layers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  layer TEXT NOT NULL CHECK (layer IN ('topic', 'week', 'month', 'relationship')),
  period_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  topics_json TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  from_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  through_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE(owner_id, layer, period_key)
);

CREATE INDEX memory_time_layers_owner_updated
  ON memory_time_layers(owner_id, layer, updated_at DESC, id DESC);
