export type DeliveryKind = "typing" | "bubble" | "notice";
const DELIVERY_LEASE_SECONDS = 300;
export type DeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "cancelled";

export interface DeliveryRecord {
  deliveryId: number;
  ownerId: number;
  assistantMessageId: number;
  kind: DeliveryKind;
  chunkIndex: number;
  chunkText: string | null;
  targetAt: number;
  targetChatId: number;
  status: DeliveryStatus;
  telegramMessageId: number | null;
  attemptCount: number;
}

interface DeliveryRow {
  id: number;
  owner_id: number;
  assistant_message_id: number;
  kind: DeliveryKind;
  chunk_index: number;
  chunk_text: string | null;
  target_at: number;
  target_chat_id: number;
  status: DeliveryStatus;
  telegram_message_id: number | null;
  attempt_count: number;
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    deliveryId: row.id,
    ownerId: row.owner_id,
    assistantMessageId: row.assistant_message_id,
    kind: row.kind,
    chunkIndex: row.chunk_index,
    chunkText: row.chunk_text,
    targetAt: row.target_at,
    targetChatId: row.target_chat_id,
    status: row.status,
    telegramMessageId: row.telegram_message_id,
    attemptCount: row.attempt_count,
  };
}

export async function createDeliveryPlan(
  db: D1Database,
  input: {
    ownerId: number;
    assistantMessageId: number;
    targetChatId: number;
    typingTargets: number[];
    bubbles: Array<{ text: string; targetAt: number }>;
    now: number;
  },
): Promise<DeliveryRecord[]> {
  const statements: D1PreparedStatement[] = [];
  for (const [index, targetAt] of input.typingTargets.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO deliveries (
             owner_id, assistant_message_id, kind, chunk_index, chunk_text,
             target_at, target_chat_id, status, created_at, updated_at
           ) VALUES (?, ?, 'typing', ?, NULL, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          input.ownerId,
          input.assistantMessageId,
          index,
          targetAt,
          input.targetChatId,
          input.now,
          input.now,
        ),
    );
  }
  for (const [index, bubble] of input.bubbles.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO deliveries (
             owner_id, assistant_message_id, kind, chunk_index, chunk_text,
             target_at, target_chat_id, status, created_at, updated_at
           ) VALUES (?, ?, 'bubble', ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          input.ownerId,
          input.assistantMessageId,
          index,
          bubble.text,
          bubble.targetAt,
          input.targetChatId,
          input.now,
          input.now,
        ),
    );
  }
  if (statements.length > 0) {
    const results = await db.batch(statements);
    if (!results.every((result) => result.success)) {
      throw new Error("delivery_plan_create_failed");
    }
  }
  return getDeliveriesForAssistant(db, input.assistantMessageId);
}

export async function getDeliveriesForAssistant(
  db: D1Database,
  assistantMessageId: number,
): Promise<DeliveryRecord[]> {
  const result = await db
    .prepare(
      `SELECT id, owner_id, assistant_message_id, kind, chunk_index,
              chunk_text, target_at, target_chat_id, status,
              telegram_message_id, attempt_count
       FROM deliveries
       WHERE assistant_message_id = ?
       ORDER BY target_at, kind, chunk_index`,
    )
    .bind(assistantMessageId)
    .all<DeliveryRow>();
  return result.results.map(toDelivery);
}

export async function getDelivery(
  db: D1Database,
  deliveryId: number,
): Promise<DeliveryRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, owner_id, assistant_message_id, kind, chunk_index,
              chunk_text, target_at, target_chat_id, status,
              telegram_message_id, attempt_count
       FROM deliveries WHERE id = ?`,
    )
    .bind(deliveryId)
    .first<DeliveryRow>();
  return row === null ? null : toDelivery(row);
}

export async function markDeliverySending(
  db: D1Database,
  deliveryId: number,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE deliveries
       SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?
         AND (
           status IN ('pending', 'failed')
           OR (status = 'sending' AND updated_at <= ?)
         )`,
    )
    .bind(now, deliveryId, now - DELIVERY_LEASE_SECONDS)
    .run();
  return result.meta.changes === 1;
}

export async function markDeliverySent(
  db: D1Database,
  deliveryId: number,
  telegramMessageId: number | null,
  now: number,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE deliveries
       SET status = 'sent', telegram_message_id = ?, last_error_code = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    )
    .bind(telegramMessageId, now, deliveryId)
    .run();
  if (result.meta.changes !== 1) throw new Error("delivery_not_sending");
}

export async function markDeliveryFailed(
  db: D1Database,
  deliveryId: number,
  errorCode: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE deliveries
       SET status = 'failed', last_error_code = ?, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
    )
    .bind(errorCode, now, deliveryId)
    .run();
}

export async function allBubblesSent(
  db: D1Database,
  assistantMessageId: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS remaining FROM deliveries
       WHERE assistant_message_id = ? AND kind IN ('bubble', 'notice')
         AND status <> 'sent'`,
    )
    .bind(assistantMessageId)
    .first<{ remaining: number }>();
  return row?.remaining === 0;
}
