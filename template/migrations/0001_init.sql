PRAGMA foreign_keys = ON;

CREATE TABLE owners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL UNIQUE,
  paired_at INTEGER NOT NULL,
  migrated_at INTEGER
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE UNIQUE INDEX one_active_conversation
  ON conversations(owner_id) WHERE status = 'active';

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  mode TEXT NOT NULL CHECK (mode IN ('persona', 'ask', 'system')),
  content TEXT NOT NULL,
  telegram_message_id INTEGER,
  telegram_update_id INTEGER UNIQUE,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX messages_by_conversation
  ON messages(conversation_id, created_at);

CREATE TABLE conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_message_id INTEGER NOT NULL,
  through_message_id INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (owner_id, fact_key)
);

CREATE TABLE processed_updates (
  telegram_update_id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
  assistant_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (
    status IN ('received', 'queued', 'processing', 'completed', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  assistant_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('typing', 'bubble', 'notice')),
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT,
  target_at INTEGER NOT NULL,
  target_chat_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')
  ),
  telegram_message_id INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assistant_message_id, kind, chunk_index)
);

CREATE TABLE usage_daily (
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, usage_date)
);

CREATE TABLE pending_confirmations (
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, command)
);

CREATE TABLE owner_recovery (
  owner_id INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE recovery_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'recover')),
  owner_id INTEGER REFERENCES owners(id) ON DELETE CASCADE,
  requested_user_id INTEGER NOT NULL,
  requested_chat_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE recovery_rate_limits (
  requester_hash TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  challenge_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (requester_hash, usage_date)
);

CREATE TABLE owner_recovery_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES recovery_challenges(id),
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  from_identity_hash TEXT NOT NULL,
  to_identity_hash TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE persona_profiles (
  owner_id INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  consent_status TEXT NOT NULL CHECK (
    consent_status IN ('confirmed', 'withdrawn')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE persona_versions (
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, version)
);

CREATE TABLE persona_change_drafts (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('correction', 'addition')),
  summary TEXT NOT NULL,
  impact_scope TEXT NOT NULL,
  patch_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE persona_version_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('create', 'correction', 'addition', 'rollback')
  ),
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE persona_runtime_state (
  owner_id INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  busy_until INTEGER,
  next_proactive_at INTEGER,
  week_start TEXT,
  weekly_target INTEGER NOT NULL DEFAULT 1 CHECK (weekly_target IN (1, 2)),
  weekly_sent INTEGER NOT NULL DEFAULT 0,
  last_proactive_at INTEGER,
  updated_at INTEGER NOT NULL
);
