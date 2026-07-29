CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  content TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  workflow_instance_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  cancelled_at INTEGER,
  UNIQUE(owner_id, code)
);

CREATE INDEX reminders_owner_status_due_idx
  ON reminders(owner_id, status, due_at);

CREATE TABLE weekly_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  week_key TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  assistant_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, week_key)
);

CREATE INDEX weekly_reviews_owner_status_idx
  ON weekly_reviews(owner_id, status, period_end);
