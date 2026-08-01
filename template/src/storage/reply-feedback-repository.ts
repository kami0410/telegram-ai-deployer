export type ReplyFeedbackKind =
  | "not_like"
  | "too_clingy"
  | "too_formal"
  | "too_long"
  | "no_advice"
  | "wrong_memory";

export interface ReplyFeedbackRecord {
  kind: ReplyFeedbackKind;
  createdAt: number;
}

const FEEDBACK_LABELS: Record<ReplyFeedbackKind, string> = {
  not_like: "这不像她；只在相似场景减少当前表达方式，不改写人格事实。",
  too_clingy: "降低黏人和索取回应的程度，保持 Persona 的独立和低频联系。",
  too_formal: "减少书面、客服和解释腔，使用更短、更自然的口语。",
  too_long: "表达相同意思时进一步缩短，不重复观点。",
  no_advice: "先听，不主动给建议；只有用户明确询问时再分析。",
  wrong_memory: "不要沿用这次引用的记忆；不确定时先承认不确定。",
};

const FEEDBACK_DRAFT_THRESHOLD = 3;
const FEEDBACK_EVIDENCE_WINDOW_SECONDS = 90 * 86_400;
const FEEDBACK_RECENT_EFFECT_SECONDS = 7 * 86_400;
const PREFERENCE_DRAFT_LIFETIME_SECONDS = 7 * 86_400;

export interface InteractionPreferenceDraft {
  id: string;
  kind: ReplyFeedbackKind;
  instruction: string;
  sourceFeedbackCount: number;
}

export function feedbackInstruction(kind: ReplyFeedbackKind): string {
  return FEEDBACK_LABELS[kind];
}

export function feedbackLabel(kind: ReplyFeedbackKind): string {
  const labels: Record<ReplyFeedbackKind, string> = {
    not_like: "不像她", too_clingy: "太黏了", too_formal: "太正式",
    too_long: "太长了", no_advice: "别急着建议", wrong_memory: "记错了",
  };
  return labels[kind];
}

export function isAdjustmentCandidate(input: {
  intent: string;
  usedMemory: boolean;
  bubbleCount: number;
  charCount: number;
}): boolean {
  return input.usedMemory ||
    ["anxiety", "advice", "listen", "conflict"].includes(input.intent) ||
    input.bubbleCount >= 4 || input.charCount >= 160;
}

export async function isLastBubbleDelivery(
  db: D1Database,
  assistantMessageId: number,
  chunkIndex: number,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS found FROM deliveries
     WHERE assistant_message_id = ? AND kind IN ('bubble', 'notice') AND chunk_index > ?
     LIMIT 1`,
  ).bind(assistantMessageId, chunkIndex).first();
  return row === null;
}

export async function recordReplyContext(
  db: D1Database,
  input: {
    ownerId: number;
    assistantMessageId: number;
    intent: string;
    stage: string;
    memoryRefs: Array<{ kind: "fact" | "episode"; id: number }>;
    bubbleCount: number;
    charCount: number;
    candidate: boolean;
    now: number;
  },
): Promise<void> {
  const result = await db.prepare(
    `INSERT OR REPLACE INTO reply_contexts (
       assistant_message_id, owner_id, intent, support_stage, memory_refs_json,
       bubble_count, char_count, adjustment_candidate, adjustment_shown_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
       (SELECT adjustment_shown_at FROM reply_contexts WHERE assistant_message_id = ?), ?)`
  ).bind(
    input.assistantMessageId,
    input.ownerId,
    input.intent.slice(0, 40),
    input.stage.slice(0, 40),
    JSON.stringify(input.memoryRefs.slice(0, 20)),
    Math.max(1, Math.floor(input.bubbleCount)),
    Math.max(0, Math.floor(input.charCount)),
    input.candidate ? 1 : 0,
    input.assistantMessageId,
    input.now,
  ).run();
  if (result.meta.changes !== 1) throw new Error("reply_context_save_failed");
}

function beijingDayStart(now: number): number {
  return Math.floor((now + 8 * 3_600) / 86_400) * 86_400 - 8 * 3_600;
}

export async function canShowAutomaticAdjustment(
  db: D1Database,
  ownerId: number,
  assistantMessageId: number,
  now: number,
): Promise<boolean> {
  const context = await db.prepare(
    `SELECT adjustment_candidate, adjustment_shown_at FROM reply_contexts
     WHERE assistant_message_id = ? AND owner_id = ?`,
  ).bind(assistantMessageId, ownerId).first<{
    adjustment_candidate: number;
    adjustment_shown_at: number | null;
  }>();
  if (context?.adjustment_candidate !== 1 || context.adjustment_shown_at !== null) return false;
  const recentClick = await db.prepare(
    `SELECT 1 AS found FROM reply_feedback
     WHERE owner_id = ? AND created_at > ? LIMIT 1`,
  ).bind(ownerId, now - 86_400).first();
  if (recentClick !== null) return false;
  const dayCount = await db.prepare(
    `SELECT COUNT(*) AS count FROM reply_contexts
     WHERE owner_id = ? AND adjustment_shown_at >= ?`,
  ).bind(ownerId, beijingDayStart(now)).first<{ count: number }>();
  if ((dayCount?.count ?? 0) >= 2) return false;
  const previous = await db.prepare(
    `SELECT assistant_message_id FROM reply_contexts
     WHERE owner_id = ? AND adjustment_shown_at IS NOT NULL
     ORDER BY adjustment_shown_at DESC LIMIT 1`,
  ).bind(ownerId).first<{ assistant_message_id: number }>();
  if (previous !== null) {
    const gap = await db.prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE owner_id = ? AND role = 'assistant' AND mode = 'persona'
         AND id > ? AND id < ?`,
    ).bind(ownerId, previous.assistant_message_id, assistantMessageId)
      .first<{ count: number }>();
    if ((gap?.count ?? 0) < 15) return false;
  }
  return true;
}

export async function markAdjustmentShown(
  db: D1Database,
  ownerId: number,
  assistantMessageId: number,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE reply_contexts SET adjustment_shown_at = ?
     WHERE assistant_message_id = ? AND owner_id = ? AND adjustment_shown_at IS NULL`,
  ).bind(now, assistantMessageId, ownerId).run();
}

export async function saveReplyFeedback(
  db: D1Database,
  input: { ownerId: number; assistantMessageId: number; kind: ReplyFeedbackKind; now: number },
): Promise<{ saved: boolean; draft: InteractionPreferenceDraft | null }> {
  const source = await db.prepare(
    `SELECT id FROM messages WHERE id = ? AND owner_id = ? AND role = 'assistant' AND mode = 'persona'`,
  ).bind(input.assistantMessageId, input.ownerId).first();
  if (source === null) return { saved: false, draft: null };
  const result = await db.prepare(
    `INSERT OR IGNORE INTO reply_feedback (id, owner_id, assistant_message_id, kind, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), input.ownerId, input.assistantMessageId, input.kind, input.now).run();
  if (result.meta.changes !== 1) return { saved: false, draft: null };
  const count = await db.prepare(
    `SELECT COUNT(*) AS count FROM reply_feedback
     WHERE owner_id = ? AND kind = ? AND created_at >= ?`,
  ).bind(input.ownerId, input.kind, input.now - FEEDBACK_EVIDENCE_WINDOW_SECONDS)
    .first<{ count: number }>();
  const sourceFeedbackCount = count?.count ?? 0;
  if (sourceFeedbackCount < FEEDBACK_DRAFT_THRESHOLD) return { saved: true, draft: null };
  const existing = await db.prepare(
    `SELECT 1 AS found FROM interaction_preferences WHERE owner_id = ? AND kind = ?
     UNION ALL
     SELECT 1 AS found FROM interaction_preference_drafts
     WHERE owner_id = ? AND kind = ? AND status = 'pending' AND expires_at >= ? LIMIT 1`,
  ).bind(input.ownerId, input.kind, input.ownerId, input.kind, input.now).first();
  if (existing !== null) return { saved: true, draft: null };
  const draft: InteractionPreferenceDraft = {
    id: crypto.randomUUID(),
    kind: input.kind,
    instruction: feedbackInstruction(input.kind),
    sourceFeedbackCount,
  };
  await db.prepare(
    `INSERT INTO interaction_preference_drafts (
       id, owner_id, kind, instruction, source_feedback_count, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(draft.id, input.ownerId, draft.kind, draft.instruction,
    draft.sourceFeedbackCount, input.now + PREFERENCE_DRAFT_LIFETIME_SECONDS, input.now).run();
  return { saved: true, draft };
}

export async function resolveInteractionPreferenceDraft(
  db: D1Database,
  ownerId: number,
  draftId: string,
  resolution: "confirmed" | "cancelled",
  now: number,
): Promise<boolean> {
  const draft = await db.prepare(
    `SELECT kind, instruction, source_feedback_count FROM interaction_preference_drafts
     WHERE id = ? AND owner_id = ? AND status = 'pending' AND expires_at >= ?`,
  ).bind(draftId, ownerId, now).first<{
    kind: ReplyFeedbackKind; instruction: string; source_feedback_count: number;
  }>();
  if (draft === null) return false;
  const statements = [db.prepare(
    `UPDATE interaction_preference_drafts SET status = ?, resolved_at = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending'`,
  ).bind(resolution, now, draftId, ownerId)];
  if (resolution === "confirmed") statements.push(db.prepare(
    `INSERT INTO interaction_preferences (
       owner_id, kind, instruction, source_feedback_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, kind) DO UPDATE SET instruction = excluded.instruction,
       source_feedback_count = excluded.source_feedback_count, updated_at = excluded.updated_at`,
  ).bind(ownerId, draft.kind, draft.instruction, draft.source_feedback_count, now, now));
  const results = await db.batch(statements);
  return results.every((entry) => entry.success) && (results[0]?.meta.changes ?? 0) === 1;
}

export async function getConfirmedInteractionPreferences(
  db: D1Database,
  ownerId: number,
): Promise<Array<{ kind: ReplyFeedbackKind; instruction: string }>> {
  const result = await db.prepare(
    `SELECT kind, instruction FROM interaction_preferences
     WHERE owner_id = ? ORDER BY updated_at DESC`,
  ).bind(ownerId).all<{ kind: ReplyFeedbackKind; instruction: string }>();
  return result.results;
}

export async function getRecentReplyFeedback(
  db: D1Database,
  ownerId: number,
  now: number,
  limit = 8,
): Promise<ReplyFeedbackRecord[]> {
  const result = await db.prepare(
    `SELECT kind, created_at FROM reply_feedback
     WHERE owner_id = ? AND created_at >= ?
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(ownerId, now - FEEDBACK_RECENT_EFFECT_SECONDS, Math.max(1, Math.min(12, Math.floor(limit))))
    .all<{ kind: ReplyFeedbackKind; created_at: number }>();
  return result.results.map((row) => ({ kind: row.kind, createdAt: row.created_at }));
}

export async function getLatestAdjustableReply(
  db: D1Database,
  ownerId: number,
): Promise<{ assistantMessageId: number; content: string } | null> {
  const row = await db.prepare(
    `SELECT id, content FROM messages
     WHERE owner_id = ? AND role = 'assistant' AND mode = 'persona'
     ORDER BY id DESC LIMIT 1`,
  ).bind(ownerId).first<{ id: number; content: string }>();
  return row === null ? null : { assistantMessageId: row.id, content: row.content };
}
