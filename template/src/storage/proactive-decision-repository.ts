import type { ProactiveDecisionKind } from "../proactive-policy";

export async function recordProactiveDecision(db: D1Database, input: {
  ownerId: number; decision: ProactiveDecisionKind; reasonCode: string; topicKey?: string;
  sourceEntityKind?: string; sourceEntityId?: number; noveltyScore: number;
  unansweredCount: number; scheduledAt: number; now: number;
}): Promise<number> {
  const row = await db.prepare(
    `INSERT INTO proactive_decisions (owner_id, decision, reason_code, topic_key,
       source_entity_kind, source_entity_id, novelty_score, unanswered_count, scheduled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(input.ownerId, input.decision, input.reasonCode.slice(0, 80), input.topicKey?.slice(0, 160) ?? null,
    input.sourceEntityKind?.slice(0, 40) ?? null, input.sourceEntityId ?? null,
    Math.max(0, Math.min(1_000, Math.round(input.noveltyScore))), Math.max(0, input.unansweredCount), input.scheduledAt, input.now)
    .first<{ id: number }>();
  if (row === null) throw new Error("proactive_decision_insert_failed");
  return row.id;
}

export async function isRecentProactiveTopic(db: D1Database, ownerId: number, topicKey: string, since: number): Promise<boolean> {
  return (await db.prepare(
    `SELECT 1 AS found FROM proactive_decisions WHERE owner_id = ? AND topic_key = ?
       AND decision = 'send' AND scheduled_at >= ? LIMIT 1`,
  ).bind(ownerId, topicKey, since).first()) !== null;
}

export async function markProactiveSent(db: D1Database, ownerId: number, scheduledAt: number, messageId: number): Promise<void> {
  await db.prepare(
    `UPDATE proactive_decisions SET sent_message_id = ? WHERE id = (
       SELECT id FROM proactive_decisions WHERE owner_id = ? AND scheduled_at = ? AND decision = 'send'
       ORDER BY id DESC LIMIT 1)`,
  ).bind(messageId, ownerId, scheduledAt).run();
}

export async function attachProactiveOutcome(db: D1Database, ownerId: number, now: number, corrected = false, assistantMessageId?: number): Promise<void> {
  if (assistantMessageId !== undefined) {
    await db.prepare(
      `UPDATE proactive_decisions SET outcome = ?, outcome_at = ?
       WHERE owner_id = ? AND decision = 'send' AND sent_message_id = ?`,
    ).bind(corrected ? "corrected" : "replied", now, ownerId, assistantMessageId).run();
    return;
  }
  await db.prepare(
    `UPDATE proactive_decisions SET outcome = ?, outcome_at = ? WHERE id = (
       SELECT id FROM proactive_decisions WHERE owner_id = ? AND decision = 'send'
         AND sent_message_id IS NOT NULL AND outcome IS NULL ORDER BY scheduled_at DESC, id DESC LIMIT 1)`,
  ).bind(corrected ? "corrected" : "replied", now, ownerId).run();
}

export async function markExpiredProactiveIgnored(db: D1Database, ownerId: number, now: number): Promise<void> {
  await db.prepare(
    `UPDATE proactive_decisions SET outcome = 'ignored', outcome_at = ?
     WHERE owner_id = ? AND decision = 'send' AND sent_message_id IS NOT NULL
       AND outcome IS NULL AND scheduled_at <= ?`,
  ).bind(now, ownerId, now - 24 * 3_600).run();
}

export async function getProactiveStats(db: D1Database, ownerId: number, since: number) {
  const counts = await db.prepare(
    `SELECT decision, COALESCE(outcome, '') AS outcome, reason_code, COUNT(*) AS count
     FROM proactive_decisions WHERE owner_id = ? AND created_at >= ?
     GROUP BY decision, outcome, reason_code ORDER BY count DESC`,
  ).bind(ownerId, since).all<{ decision: ProactiveDecisionKind; outcome: string; reason_code: string; count: number }>();
  return counts.results.map((row) => ({ decision: row.decision, outcome: row.outcome || null, reasonCode: row.reason_code, count: row.count }));
}
