CREATE TABLE memory_recall_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  assistant_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  query_hash TEXT NOT NULL,
  explicit_history INTEGER NOT NULL CHECK (explicit_history IN (0, 1)),
  model TEXT NOT NULL,
  persona_version INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX memory_recall_traces_owner_created
  ON memory_recall_traces(owner_id, created_at DESC, id DESC);

CREATE TABLE memory_recall_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  trace_id INTEGER NOT NULL REFERENCES memory_recall_traces(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('fact', 'episode', 'graph')),
  entity_id INTEGER NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  source_message_id INTEGER,
  channel TEXT NOT NULL CHECK (channel IN ('lexical', 'semantic', 'graph', 'pinned')),
  total_score INTEGER NOT NULL,
  relevance_score INTEGER NOT NULL,
  confidence_score INTEGER NOT NULL,
  recency_score INTEGER NOT NULL,
  control_score INTEGER NOT NULL,
  channel_score INTEGER NOT NULL,
  diversity_score INTEGER NOT NULL,
  reason_codes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(trace_id, entity_kind, entity_id)
);
CREATE INDEX memory_recall_items_owner_trace
  ON memory_recall_items(owner_id, trace_id, total_score DESC);
