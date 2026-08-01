CREATE TABLE memory_controls (
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('fact', 'episode')),
  entity_id INTEGER NOT NULL,
  control TEXT NOT NULL CHECK (control IN ('normal', 'pinned', 'ignored')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, entity_kind, entity_id)
);

CREATE INDEX memory_controls_owner_control
  ON memory_controls(owner_id, control, updated_at DESC);
