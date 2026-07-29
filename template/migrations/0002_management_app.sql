ALTER TABLE persona_change_drafts ADD COLUMN source_message_id INTEGER
  REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX persona_drafts_by_owner_created
  ON persona_change_drafts(owner_id, created_at DESC);

CREATE INDEX memory_facts_by_owner_updated
  ON memory_facts(owner_id, updated_at DESC, id DESC);

CREATE TABLE management_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX management_events_by_owner_created
  ON management_events(owner_id, created_at DESC);
