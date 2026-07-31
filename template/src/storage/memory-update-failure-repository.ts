export async function recordMemoryUpdateFailure(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    errorCode: string;
    now: number;
  },
): Promise<void> {
  await db.prepare(
    `INSERT INTO memory_update_failures (
       owner_id, conversation_id, error_code, failure_count,
       first_failed_at, last_failed_at
     ) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(owner_id, conversation_id) DO UPDATE SET
       error_code = excluded.error_code,
       failure_count = memory_update_failures.failure_count + 1,
       last_failed_at = excluded.last_failed_at`,
  ).bind(
    input.ownerId,
    input.conversationId,
    input.errorCode,
    input.now,
    input.now,
  ).run();
}

export async function clearMemoryUpdateFailure(
  db: D1Database,
  ownerId: number,
  conversationId: number,
): Promise<void> {
  await db.prepare(
    "DELETE FROM memory_update_failures WHERE owner_id = ? AND conversation_id = ?",
  ).bind(ownerId, conversationId).run();
}
