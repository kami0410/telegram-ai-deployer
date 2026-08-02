CREATE TABLE identity_core_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, identity_key, version)
);
CREATE INDEX identity_core_entries_active
  ON identity_core_entries(owner_id, status, identity_key, updated_at DESC);

CREATE TABLE identity_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'ready', 'promoted', 'rejected')),
  evidence_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE(owner_id, identity_key, identity_value)
);
CREATE INDEX identity_candidates_owner_status
  ON identity_candidates(owner_id, status, updated_at DESC, id DESC);

CREATE TABLE identity_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  candidate_id INTEGER NOT NULL REFERENCES identity_candidates(id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(candidate_id, source_message_id)
);

CREATE TABLE identity_core_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  identity_key TEXT NOT NULL,
  previous_entry_id INTEGER,
  new_entry_id INTEGER,
  candidate_id INTEGER,
  action TEXT NOT NULL CHECK (action IN ('promote', 'revert')),
  created_at INTEGER NOT NULL
);
CREATE INDEX identity_core_history_owner_created
  ON identity_core_history(owner_id, created_at DESC, id DESC);
