import type { UpdateClaim, UpdateStatus } from "../domain";

interface UpdateRow {
  status: UpdateStatus;
}

export async function claimUpdate(
  db: D1Database,
  telegramUpdateId: number,
  ownerId: number,
  now: number,
): Promise<UpdateClaim> {
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO processed_updates (
         telegram_update_id, owner_id, status, created_at, updated_at
       ) VALUES (?, ?, 'received', ?, ?)`,
    )
    .bind(telegramUpdateId, ownerId, now, now)
    .run();

  if (inserted.meta.changes === 1) return "new";

  const existing = await db
    .prepare(
      `SELECT status
       FROM processed_updates
       WHERE telegram_update_id = ?`,
    )
    .bind(telegramUpdateId)
    .first<UpdateRow>();

  if (existing === null) {
    throw new Error("processed_update_missing_after_conflict");
  }

  return existing.status === "received" || existing.status === "failed"
    ? "requeue"
    : "duplicate";
}

export async function markUpdate(
  db: D1Database,
  telegramUpdateId: number,
  status: UpdateStatus,
  now: number,
  lastErrorCode: string | null = null,
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE processed_updates
       SET status = ?,
           updated_at = ?,
           last_error_code = ?,
           attempt_count = attempt_count + CASE WHEN ? = 'processing' THEN 1 ELSE 0 END
       WHERE telegram_update_id = ?`,
    )
    .bind(status, now, lastErrorCode, status, telegramUpdateId)
    .run();

  if (result.meta.changes !== 1) {
    throw new Error("processed_update_not_found");
  }
}
