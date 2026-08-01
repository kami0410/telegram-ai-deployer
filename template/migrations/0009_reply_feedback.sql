CREATE TABLE reply_contexts (
  assistant_message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  intent TEXT NOT NULL,
  support_stage TEXT NOT NULL,
  memory_refs_json TEXT NOT NULL DEFAULT '[]',
  bubble_count INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  adjustment_candidate INTEGER NOT NULL DEFAULT 0 CHECK (adjustment_candidate IN (0, 1)),
  adjustment_shown_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX reply_contexts_owner_created
  ON reply_contexts(owner_id, created_at DESC, assistant_message_id DESC);

CREATE TABLE reply_feedback (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  assistant_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'not_like', 'too_clingy', 'too_formal',
    'too_long', 'no_advice', 'wrong_memory'
  )),
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, assistant_message_id)
);

CREATE INDEX reply_feedback_owner_created
  ON reply_feedback(owner_id, created_at DESC);
