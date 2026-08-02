CREATE TABLE memory_graph_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('person', 'event', 'topic', 'goal', 'place', 'time')),
  canonical_key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'conflicted', 'ignored')),
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX memory_graph_nodes_one_active
  ON memory_graph_nodes(owner_id, node_type, canonical_key)
  WHERE status = 'active';
CREATE INDEX memory_graph_nodes_owner_status_type
  ON memory_graph_nodes(owner_id, status, node_type, updated_at DESC);

CREATE TABLE memory_graph_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  node_id INTEGER NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'fact', 'episode', 'relationship')),
  source_entity_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, node_id, source_kind, source_entity_id, source_message_id)
);
CREATE INDEX memory_graph_sources_owner_node
  ON memory_graph_sources(owner_id, node_id, created_at DESC);

CREATE TABLE memory_graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  from_node_id INTEGER NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
  to_node_id INTEGER NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('involves', 'occurred_at', 'related_to', 'supports', 'updates', 'conflicts_with')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'ignored')),
  source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, from_node_id, to_node_id, relation_type, source_message_id)
);
CREATE INDEX memory_graph_edges_owner_status
  ON memory_graph_edges(owner_id, status, updated_at DESC);

CREATE TABLE memory_graph_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('person', 'event', 'topic', 'goal', 'place', 'time')),
  canonical_key TEXT NOT NULL,
  existing_node_id INTEGER NOT NULL REFERENCES memory_graph_nodes(id) ON DELETE CASCADE,
  candidate_value TEXT NOT NULL,
  candidate_confidence TEXT NOT NULL CHECK (candidate_confidence IN ('low', 'medium', 'high')),
  source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resolved_new', 'resolved_existing')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX memory_graph_conflicts_pending
  ON memory_graph_conflicts(owner_id, node_type, canonical_key, candidate_value)
  WHERE status = 'pending';
CREATE INDEX memory_graph_conflicts_owner_status
  ON memory_graph_conflicts(owner_id, status, created_at DESC);
