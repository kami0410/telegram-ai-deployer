CREATE TABLE quality_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('retrieval','degradation','correction','proactive','evaluation','safety','error')),
  reason_code TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  persona_version INTEGER NOT NULL,
  worker_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX quality_events_owner_created
  ON quality_events(owner_id, created_at DESC, id DESC);
