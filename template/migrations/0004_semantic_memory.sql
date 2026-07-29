CREATE TABLE memory_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  people_json TEXT NOT NULL DEFAULT '[]',
  topics_json TEXT NOT NULL DEFAULT '[]',
  occurred_at INTEGER NOT NULL,
  auto_inject_until INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX memory_episodes_by_owner_time
  ON memory_episodes(owner_id, status, occurred_at DESC, id DESC);

CREATE TABLE memory_conflicts (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  existing_fact_id INTEGER NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  candidate_category TEXT NOT NULL,
  candidate_fact_value TEXT NOT NULL,
  candidate_confidence TEXT NOT NULL CHECK (candidate_confidence IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'use_new', 'keep_old', 'expired')
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX memory_conflicts_by_owner_status
  ON memory_conflicts(owner_id, status, expires_at DESC);

CREATE TABLE memory_vector_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('fact', 'episode')),
  entity_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, entity_kind, entity_id)
);

CREATE INDEX memory_vector_jobs_pending
  ON memory_vector_jobs(status, updated_at, id);

INSERT INTO memory_vector_jobs (
  owner_id, entity_kind, entity_id, operation, status, created_at, updated_at
)
SELECT owner_id, 'fact', id, 'upsert', 'pending', updated_at, updated_at
FROM memory_facts;
