CREATE TABLE interaction_preferences (
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('not_like', 'too_clingy', 'too_formal', 'too_long', 'no_advice', 'wrong_memory')),
  instruction TEXT NOT NULL,
  source_feedback_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, kind)
);

CREATE TABLE interaction_preference_drafts (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('not_like', 'too_clingy', 'too_formal', 'too_long', 'no_advice', 'wrong_memory')),
  instruction TEXT NOT NULL,
  source_feedback_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE UNIQUE INDEX interaction_preference_drafts_pending
  ON interaction_preference_drafts(owner_id, kind) WHERE status = 'pending';
