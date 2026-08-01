export type RelationshipStateKind =
  | "open_thread"
  | "emotional_state"
  | "commitment"
  | "shared_moment"
  | "interaction_outcome";

export interface RelationshipStateInput {
  kind: RelationshipStateKind;
  value: string;
  sourceMessageId: number;
}

export interface RelationshipStateRecord extends RelationshipStateInput {
  id: number;
  expiresAt: number | null;
  updatedAt: number;
}

interface RelationshipStateRow {
  id: number;
  kind: RelationshipStateKind;
  value: string;
  source_message_id: number;
  expires_at: number | null;
  updated_at: number;
}

const TEMPORARY_LIFETIMES: Partial<Record<RelationshipStateKind, number>> = {
  open_thread: 30 * 86_400,
  emotional_state: 7 * 86_400,
  commitment: 90 * 86_400,
  interaction_outcome: 7 * 86_400,
};

const OPEN_THREAD_FOLLOW_UP_DELAY_SECONDS = 6 * 3_600;

export interface OpenThreadFollowUp {
  id: number;
  value: string;
  sourceContent: string;
  updatedAt: number;
}

function asRecord(row: RelationshipStateRow): RelationshipStateRecord {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    sourceMessageId: row.source_message_id,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

export async function saveRelationshipStates(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    states: RelationshipStateInput[];
    now: number;
  },
): Promise<number> {
  const unique = new Map<string, RelationshipStateInput>();
  for (const state of input.states.slice(0, 20)) {
    const value = state.value.trim().slice(0, 500);
    if (value.length === 0) continue;
    unique.set(`${state.kind}\u0000${value}`, { ...state, value });
  }
  const statements: D1PreparedStatement[] = [];
  if ([...unique.values()].some((state) => state.kind === "emotional_state")) {
    statements.push(db.prepare(
      `UPDATE relationship_states SET status = 'resolved', updated_at = ?
       WHERE owner_id = ? AND kind = 'emotional_state' AND status = 'active'`,
    ).bind(input.now, input.ownerId));
  }
  for (const state of unique.values()) {
    const source = await db.prepare(
      `SELECT id FROM messages
       WHERE id = ? AND owner_id = ? AND conversation_id = ? AND role = 'user'`,
    ).bind(state.sourceMessageId, input.ownerId, input.conversationId).first();
    if (source === null) throw new Error("relationship_source_not_found");
    const lifetime = TEMPORARY_LIFETIMES[state.kind];
    const expiresAt = lifetime === undefined ? null : input.now + lifetime;
    statements.push(db.prepare(
      `INSERT INTO relationship_states (
         owner_id, source_conversation_id, source_message_id, kind, value,
         expires_at, status, created_at, updated_at,
         follow_up_after, followed_up_at, follow_up_attempts
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, 0)
       ON CONFLICT(owner_id, kind, value) DO UPDATE SET
         source_conversation_id = excluded.source_conversation_id,
         source_message_id = excluded.source_message_id,
         expires_at = excluded.expires_at,
         follow_up_after = CASE WHEN excluded.kind = 'open_thread'
           THEN excluded.updated_at + ${OPEN_THREAD_FOLLOW_UP_DELAY_SECONDS}
           ELSE relationship_states.follow_up_after END,
         followed_up_at = CASE WHEN excluded.kind = 'open_thread'
           THEN NULL ELSE relationship_states.followed_up_at END,
         follow_up_attempts = CASE WHEN excluded.kind = 'open_thread'
           THEN 0 ELSE relationship_states.follow_up_attempts END,
         status = 'active', updated_at = excluded.updated_at`,
    ).bind(input.ownerId, input.conversationId, state.sourceMessageId, state.kind,
      state.value, expiresAt, input.now, input.now,
      state.kind === "open_thread" ? input.now + OPEN_THREAD_FOLLOW_UP_DELAY_SECONDS : null));
  }
  if (statements.length === 0) return 0;
  const results = await db.batch(statements);
  if (!results.every((result) => result.success)) throw new Error("relationship_state_save_failed");
  return statements.length;
}

export async function getEligibleOpenThreadFollowUp(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<OpenThreadFollowUp | null> {
  const row = await db.prepare(
    `SELECT relationship_states.id, relationship_states.value,
            relationship_states.updated_at, messages.content AS source_content
     FROM relationship_states
     JOIN messages ON messages.id = relationship_states.source_message_id
     WHERE relationship_states.owner_id = ?
       AND relationship_states.kind = 'open_thread'
       AND relationship_states.status = 'active'
       AND relationship_states.followed_up_at IS NULL
       AND relationship_states.follow_up_after IS NOT NULL
       AND relationship_states.follow_up_after <= ?
       AND (relationship_states.expires_at IS NULL OR relationship_states.expires_at >= ?)
       AND COALESCE((SELECT consecutive_unanswered FROM owner_chat_preferences
         WHERE owner_id = relationship_states.owner_id), 0) = 0
     ORDER BY relationship_states.follow_up_after, relationship_states.updated_at, relationship_states.id
     LIMIT 1`,
  ).bind(ownerId, now, now).first<{
    id: number;
    value: string;
    source_content: string;
    updated_at: number;
  }>();
  return row === null ? null : {
    id: row.id,
    value: row.value,
    sourceContent: row.source_content,
    updatedAt: row.updated_at,
  };
}

export async function markOpenThreadFollowedUp(
  db: D1Database,
  ownerId: number,
  stateId: number,
  now: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE relationship_states
     SET followed_up_at = ?, follow_up_attempts = follow_up_attempts + 1, updated_at = ?
     WHERE id = ? AND owner_id = ? AND kind = 'open_thread'
       AND status = 'active' AND followed_up_at IS NULL`,
  ).bind(now, now, stateId, ownerId).run();
  return result.meta.changes === 1;
}

export async function getActiveRelationshipStates(
  db: D1Database,
  ownerId: number,
  now: number,
  limit = 12,
): Promise<RelationshipStateRecord[]> {
  const result = await db.prepare(
    `SELECT id, kind, value, source_message_id, expires_at, updated_at
     FROM relationship_states
     WHERE owner_id = ? AND status = 'active'
       AND (expires_at IS NULL OR expires_at >= ?)
       AND NOT EXISTS (SELECT 1 FROM relationship_state_controls
         WHERE owner_id = relationship_states.owner_id
           AND relationship_state_id = relationship_states.id AND control = 'ignored')
     ORDER BY CASE kind
       WHEN 'open_thread' THEN 1 WHEN 'commitment' THEN 2
       WHEN 'emotional_state' THEN 3 WHEN 'interaction_outcome' THEN 4 ELSE 5 END,
       CASE WHEN EXISTS (SELECT 1 FROM relationship_state_controls
         WHERE owner_id = relationship_states.owner_id
           AND relationship_state_id = relationship_states.id AND control = 'pinned')
         THEN 0 ELSE 1 END,
       updated_at DESC, id DESC LIMIT ?`,
  ).bind(ownerId, now, Math.max(1, Math.min(20, Math.floor(limit))))
    .all<RelationshipStateRow>();
  return result.results.map(asRecord);
}
