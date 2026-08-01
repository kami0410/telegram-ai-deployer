CREATE TABLE owner_chat_preferences (
  owner_id INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  proactive_enabled INTEGER NOT NULL DEFAULT 1 CHECK (proactive_enabled IN (0, 1)),
  daily_min INTEGER NOT NULL DEFAULT 2 CHECK (daily_min BETWEEN 1 AND 3),
  daily_max INTEGER NOT NULL DEFAULT 3 CHECK (daily_max BETWEEN 1 AND 3),
  quiet_start_minute INTEGER CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute INTEGER CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  paused_until INTEGER,
  consecutive_unanswered INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  CHECK (daily_min <= daily_max),
  CHECK ((quiet_start_minute IS NULL) = (quiet_end_minute IS NULL))
);

-- The original runtime table encoded a 2-3 contact target as 1-2. Allow 0 so
-- the same encoding can represent the new user-selectable minimum of 1.
CREATE TABLE persona_runtime_state_v2 (
  owner_id INTEGER PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  busy_until INTEGER,
  next_proactive_at INTEGER,
  week_start TEXT,
  weekly_target INTEGER NOT NULL DEFAULT 1 CHECK (weekly_target BETWEEN 0 AND 2),
  weekly_sent INTEGER NOT NULL DEFAULT 0,
  last_proactive_at INTEGER,
  updated_at INTEGER NOT NULL
);

INSERT INTO persona_runtime_state_v2 (
  owner_id, busy_until, next_proactive_at, week_start, weekly_target,
  weekly_sent, last_proactive_at, updated_at
)
SELECT owner_id, busy_until, next_proactive_at, week_start, weekly_target,
       weekly_sent, last_proactive_at, updated_at
FROM persona_runtime_state;

DROP TABLE persona_runtime_state;
ALTER TABLE persona_runtime_state_v2 RENAME TO persona_runtime_state;
