export type MemoryGraphNodeType = "person" | "event" | "topic" | "goal" | "place" | "time";
export type MemoryGraphConfidence = "low" | "medium" | "high";
export type MemoryGraphRelation =
  | "involves"
  | "occurred_at"
  | "related_to"
  | "supports"
  | "updates"
  | "conflicts_with";

export interface MemoryGraphNodeInput {
  type: MemoryGraphNodeType;
  key: string;
  value: string;
  confidence: MemoryGraphConfidence;
  sourceMessageId: number;
  sourceKind?: "message" | "fact" | "episode" | "relationship";
  sourceEntityId?: number;
  supersedes?: boolean;
}

export interface MemoryGraphEdgeInput {
  fromType: MemoryGraphNodeType;
  fromKey: string;
  toType: MemoryGraphNodeType;
  toKey: string;
  relation: MemoryGraphRelation;
  confidence: MemoryGraphConfidence;
  sourceMessageId: number;
}

export interface GraphUpdateResult {
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  edges: number;
}

export interface GraphMemoryCandidate {
  id: number;
  type: MemoryGraphNodeType;
  key: string;
  value: string;
  confidence: MemoryGraphConfidence;
  sourceMessageId: number;
  updatedAt: number;
}

interface ActiveNodeRow {
  id: number;
  value: string;
  confidence: MemoryGraphConfidence;
}

function canonicalKey(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[\s\u3000]+/gu, "_")
    .replace(/[^\p{Letter}\p{Number}_:-]+/gu, "")
    .replace(/^[_:-]+|[_:-]+$/gu, "")
    .slice(0, 120);
  if (normalized.length === 0) throw new Error("memory_graph_key_invalid");
  return normalized;
}

function cleanValue(value: string): string {
  const cleaned = value.trim().slice(0, 1_000);
  if (cleaned.length === 0) throw new Error("memory_graph_value_invalid");
  return cleaned;
}

async function assertOwnedUserMessage(
  db: D1Database,
  ownerId: number,
  messageId: number,
): Promise<void> {
  const source = await db.prepare(
    "SELECT id FROM messages WHERE id = ? AND owner_id = ? AND role = 'user'",
  ).bind(messageId, ownerId).first();
  if (source === null) throw new Error("memory_graph_source_not_found");
}

async function activeNode(
  db: D1Database,
  ownerId: number,
  type: MemoryGraphNodeType,
  key: string,
): Promise<ActiveNodeRow | null> {
  return db.prepare(
    `SELECT id, value, confidence FROM memory_graph_nodes
     WHERE owner_id = ? AND node_type = ? AND canonical_key = ? AND status = 'active'`,
  ).bind(ownerId, type, key).first<ActiveNodeRow>();
}

async function insertNode(
  db: D1Database,
  ownerId: number,
  node: MemoryGraphNodeInput,
  key: string,
  value: string,
  now: number,
): Promise<number> {
  const inserted = await db.prepare(
    `INSERT INTO memory_graph_nodes (
       owner_id, node_type, canonical_key, value, confidence, status,
       valid_from, valid_to, first_seen_at, last_confirmed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)
     RETURNING id`,
  ).bind(ownerId, node.type, key, value, node.confidence, now, now, now, now, now)
    .first<{ id: number }>();
  if (inserted === null) throw new Error("memory_graph_node_insert_failed");
  await db.prepare(
    `INSERT OR IGNORE INTO memory_graph_sources (
       owner_id, node_id, source_kind, source_entity_id, source_message_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    ownerId,
    inserted.id,
    node.sourceKind ?? "message",
    node.sourceEntityId ?? node.sourceMessageId,
    node.sourceMessageId,
    now,
  ).run();
  return inserted.id;
}

export async function upsertMemoryGraph(
  db: D1Database,
  input: {
    ownerId: number;
    nodes: MemoryGraphNodeInput[];
    edges: MemoryGraphEdgeInput[];
    now: number;
  },
): Promise<GraphUpdateResult> {
  const result: GraphUpdateResult = { created: 0, updated: 0, unchanged: 0, conflicts: 0, edges: 0 };
  for (const node of input.nodes.slice(0, 50)) {
    await assertOwnedUserMessage(db, input.ownerId, node.sourceMessageId);
    const key = canonicalKey(node.key);
    const value = cleanValue(node.value);
    const current = await activeNode(db, input.ownerId, node.type, key);
    if (current === null) {
      await insertNode(db, input.ownerId, node, key, value, input.now);
      result.created += 1;
      continue;
    }
    if (current.value === value) {
      await db.batch([
        db.prepare(
          `UPDATE memory_graph_nodes SET confidence = ?, last_confirmed_at = ?, updated_at = ?
           WHERE id = ? AND owner_id = ?`,
        ).bind(node.confidence, input.now, input.now, current.id, input.ownerId),
        db.prepare(
          `INSERT OR IGNORE INTO memory_graph_sources (
             owner_id, node_id, source_kind, source_entity_id, source_message_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          input.ownerId,
          current.id,
          node.sourceKind ?? "message",
          node.sourceEntityId ?? node.sourceMessageId,
          node.sourceMessageId,
          input.now,
        ),
      ]);
      result.unchanged += 1;
      continue;
    }
    if (node.supersedes === true) {
      await db.prepare(
        `UPDATE memory_graph_nodes SET status = 'superseded', valid_to = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'active'`,
      ).bind(input.now, input.now, current.id, input.ownerId).run();
      await insertNode(db, input.ownerId, node, key, value, input.now);
      result.updated += 1;
      continue;
    }
    const conflict = await db.prepare(
      `INSERT OR IGNORE INTO memory_graph_conflicts (
         owner_id, node_type, canonical_key, existing_node_id, candidate_value,
         candidate_confidence, source_message_id, status, created_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    ).bind(
      input.ownerId, node.type, key, current.id, value, node.confidence,
      node.sourceMessageId, input.now,
    ).run();
    if (conflict.meta.changes === 1) result.conflicts += 1;
  }

  for (const edge of input.edges.slice(0, 50)) {
    await assertOwnedUserMessage(db, input.ownerId, edge.sourceMessageId);
    const from = await activeNode(db, input.ownerId, edge.fromType, canonicalKey(edge.fromKey));
    const to = await activeNode(db, input.ownerId, edge.toType, canonicalKey(edge.toKey));
    if (from === null || to === null || from.id === to.id) continue;
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO memory_graph_edges (
         owner_id, from_node_id, to_node_id, relation_type, confidence,
         status, source_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      input.ownerId, from.id, to.id, edge.relation, edge.confidence,
      edge.sourceMessageId, input.now, input.now,
    ).run();
    result.edges += inserted.meta.changes === 1 ? 1 : 0;
  }
  return result;
}

export async function resolveMemoryGraphConflict(
  db: D1Database,
  ownerId: number,
  conflictId: number,
  resolution: "use_new" | "keep_existing",
  now: number,
): Promise<boolean> {
  const conflict = await db.prepare(
    `SELECT id, node_type, canonical_key, existing_node_id, candidate_value,
            candidate_confidence, source_message_id
     FROM memory_graph_conflicts
     WHERE id = ? AND owner_id = ? AND status = 'pending'`,
  ).bind(conflictId, ownerId).first<{
    id: number;
    node_type: MemoryGraphNodeType;
    canonical_key: string;
    existing_node_id: number;
    candidate_value: string;
    candidate_confidence: MemoryGraphConfidence;
    source_message_id: number;
  }>();
  if (conflict === null) return false;
  if (resolution === "keep_existing") {
    const saved = await db.prepare(
      `UPDATE memory_graph_conflicts SET status = 'resolved_existing', resolved_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'pending'`,
    ).bind(now, conflictId, ownerId).run();
    return saved.meta.changes === 1;
  }
  const statements = [
    db.prepare(
      `UPDATE memory_graph_nodes SET status = 'superseded', valid_to = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'active'`,
    ).bind(now, now, conflict.existing_node_id, ownerId),
    db.prepare(
      `INSERT INTO memory_graph_nodes (
         owner_id, node_type, canonical_key, value, confidence, status,
         valid_from, valid_to, first_seen_at, last_confirmed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?, ?)`,
    ).bind(
      ownerId, conflict.node_type, conflict.canonical_key, conflict.candidate_value,
      conflict.candidate_confidence, now, now, now, now, now,
    ),
    db.prepare(
      `INSERT INTO memory_graph_sources (
         owner_id, node_id, source_kind, source_entity_id, source_message_id, created_at
       ) SELECT ?, id, 'message', ?, ?, ? FROM memory_graph_nodes
         WHERE owner_id = ? AND node_type = ? AND canonical_key = ? AND status = 'active'`,
    ).bind(
      ownerId, conflict.source_message_id, conflict.source_message_id, now,
      ownerId, conflict.node_type, conflict.canonical_key,
    ),
    db.prepare(
      `UPDATE memory_graph_conflicts SET status = 'resolved_new', resolved_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'pending'`,
    ).bind(now, conflictId, ownerId),
  ];
  const results = await db.batch(statements);
  return results.every((entry) => entry.success);
}

export async function getGraphCandidates(
  db: D1Database,
  ownerId: number,
  query: string,
  limit = 10,
): Promise<GraphMemoryCandidate[]> {
  const needle = `%${query.trim().slice(0, 120)}%`;
  const result = await db.prepare(
    `SELECT memory_graph_nodes.id, memory_graph_nodes.node_type,
            memory_graph_nodes.canonical_key, memory_graph_nodes.value,
            memory_graph_nodes.confidence, memory_graph_nodes.updated_at,
            memory_graph_sources.source_message_id
     FROM memory_graph_nodes
     JOIN memory_graph_sources ON memory_graph_sources.node_id = memory_graph_nodes.id
       AND memory_graph_sources.owner_id = memory_graph_nodes.owner_id
     WHERE memory_graph_nodes.owner_id = ? AND memory_graph_nodes.status = 'active'
       AND (memory_graph_nodes.canonical_key LIKE ? OR memory_graph_nodes.value LIKE ?)
     GROUP BY memory_graph_nodes.id
     ORDER BY CASE memory_graph_nodes.confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              memory_graph_nodes.updated_at DESC
     LIMIT ?`,
  ).bind(ownerId, needle, needle, Math.max(1, Math.min(30, Math.floor(limit))))
    .all<{
      id: number;
      node_type: MemoryGraphNodeType;
      canonical_key: string;
      value: string;
      confidence: MemoryGraphConfidence;
      source_message_id: number;
      updated_at: number;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    type: row.node_type,
    key: row.canonical_key,
    value: row.value,
    confidence: row.confidence,
    sourceMessageId: row.source_message_id,
    updatedAt: row.updated_at,
  }));
}
