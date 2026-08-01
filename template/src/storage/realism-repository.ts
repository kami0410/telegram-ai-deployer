import type { ExtractedRelationshipState } from "../deepseek";

export interface ConversationSignals {
  secondsSinceLastUserMessage: number | null;
  averageRecentUserChars: number;
  consecutiveAssistantQuestions: number;
  topicStage: "opening" | "developing" | "winding_down";
  recentAssistantOpenings: string[];
}

export async function getConversationSignals(
  db: D1Database,
  ownerId: number,
  conversationId: number,
  now: number,
): Promise<ConversationSignals> {
  const rows = await db.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE owner_id = ? AND conversation_id = ? AND mode = 'persona'
     ORDER BY id DESC LIMIT 16`,
  ).bind(ownerId, conversationId).all<{
    role: "user" | "assistant"; content: string; created_at: number;
  }>();
  const recent = rows.results;
  const users = recent.filter((row) => row.role === "user");
  const assistants = recent.filter((row) => row.role === "assistant");
  let consecutiveAssistantQuestions = 0;
  for (const row of recent) {
    if (row.role === "user") continue;
    if (/[?？]\s*$/u.test(row.content)) consecutiveAssistantQuestions = 1;
    break;
  }
  const previousUser = users[1] ?? users[0];
  const gap = previousUser === undefined ? null : Math.max(0, now - previousUser.created_at);
  return {
    secondsSinceLastUserMessage: gap,
    averageRecentUserChars: users.length === 0 ? 0
      : Math.round(users.reduce((sum, row) => sum + row.content.length, 0) / users.length),
    consecutiveAssistantQuestions,
    topicStage: recent.length <= 3 ? "opening"
      : gap !== null && gap >= 12 * 3_600 ? "winding_down" : "developing",
    recentAssistantOpenings: assistants.slice(0, 6).map((row) => row.content.trim().slice(0, 18)),
  };
}

export async function saveEvidenceReflection(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    relationshipStates: ExtractedRelationshipState[];
    now: number;
  },
): Promise<void> {
  const evidence = input.relationshipStates
    .map((state) => state.value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .slice(0, 6);
  if (evidence.length === 0) return;
  const periodKey = new Date((input.now + 8 * 3_600) * 1_000).toISOString().slice(0, 10);
  await db.prepare(
    `INSERT INTO interaction_reflections (
       owner_id, conversation_id, period_key, summary, evidence_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, period_key) DO UPDATE SET
       conversation_id = excluded.conversation_id, summary = excluded.summary,
       evidence_count = excluded.evidence_count, updated_at = excluded.updated_at`,
  ).bind(input.ownerId, input.conversationId, periodKey,
    evidence.join("；").slice(0, 1600), evidence.length, input.now, input.now).run();
}

export async function getRecentEvidenceReflections(
  db: D1Database,
  ownerId: number,
  limit = 3,
): Promise<Array<{ summary: string; updatedAt: number }>> {
  const result = await db.prepare(
    `SELECT summary, updated_at FROM interaction_reflections
     WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?`,
  ).bind(ownerId, Math.max(1, Math.min(5, Math.floor(limit))))
    .all<{ summary: string; updated_at: number }>();
  return result.results.map((row) => ({ summary: row.summary, updatedAt: row.updated_at }));
}

export async function listRelationshipTimeline(db: D1Database, ownerId: number): Promise<unknown[]> {
  const result = await db.prepare(
    `SELECT relationship_states.id, relationship_states.kind, relationship_states.value,
            relationship_states.status, relationship_states.created_at,
            relationship_states.updated_at, relationship_states.expires_at,
            relationship_states.source_message_id,
            COALESCE(relationship_state_controls.control, 'normal') AS control
     FROM relationship_states
     LEFT JOIN relationship_state_controls
       ON relationship_state_controls.owner_id = relationship_states.owner_id
      AND relationship_state_controls.relationship_state_id = relationship_states.id
     WHERE relationship_states.owner_id = ?
     ORDER BY CASE COALESCE(relationship_state_controls.control, 'normal')
       WHEN 'pinned' THEN 0 ELSE 1 END, relationship_states.updated_at DESC LIMIT 100`,
  ).bind(ownerId).all<{
    id: number; kind: string; value: string; status: string; created_at: number;
    updated_at: number; expires_at: number | null; source_message_id: number; control: string;
  }>();
  return result.results.map((row) => ({
    id: row.id, kind: row.kind, value: row.value, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    sourceMessageId: row.source_message_id, confidence: "user-sourced", control: row.control,
  }));
}

export async function updateRelationshipTimelineItem(
  db: D1Database,
  ownerId: number,
  id: number,
  input: { value?: string; control?: "normal" | "pinned" | "ignored"; now: number },
): Promise<boolean> {
  const exists = await db.prepare(
    "SELECT id FROM relationship_states WHERE id = ? AND owner_id = ?",
  ).bind(id, ownerId).first();
  if (exists === null) return false;
  const statements: D1PreparedStatement[] = [];
  if (input.value !== undefined) {
    const value = input.value.trim();
    if (value.length === 0 || value.length > 500) throw new Error("relationship_value_invalid");
    statements.push(db.prepare(
      "UPDATE relationship_states SET value = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
    ).bind(value, input.now, id, ownerId));
  }
  if (input.control !== undefined) statements.push(db.prepare(
    `INSERT INTO relationship_state_controls (owner_id, relationship_state_id, control, updated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, relationship_state_id) DO UPDATE SET
       control = excluded.control, updated_at = excluded.updated_at`,
  ).bind(ownerId, id, input.control, input.now));
  if (statements.length === 0) return false;
  const results = await db.batch(statements);
  return results.every((entry) => entry.success);
}
