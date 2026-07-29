import type { OwnerRecord } from "../domain";

interface OwnerRow {
  id: number;
  telegram_user_id: number;
  telegram_chat_id: number;
  paired_at: number;
  migrated_at: number | null;
}

function toOwner(row: OwnerRow): OwnerRecord {
  return {
    ownerId: row.id,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    pairedAt: row.paired_at,
    migratedAt: row.migrated_at,
  };
}

export async function getOwner(db: D1Database): Promise<OwnerRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, telegram_user_id, telegram_chat_id, paired_at, migrated_at
       FROM owners
       ORDER BY id
       LIMIT 1`,
    )
    .first<OwnerRow>();

  return row === null ? null : toOwner(row);
}

export async function pairOwner(
  db: D1Database,
  telegramUserId: number,
  telegramChatId: number,
  pairedAt: number,
): Promise<OwnerRecord | null> {
  const row = await db
    .prepare(
      `INSERT INTO owners (telegram_user_id, telegram_chat_id, paired_at)
       SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM owners)
       RETURNING id, telegram_user_id, telegram_chat_id, paired_at, migrated_at`,
    )
    .bind(telegramUserId, telegramChatId, pairedAt)
    .first<OwnerRow>();

  return row === null ? null : toOwner(row);
}

export async function rebindOwner(
  db: D1Database,
  ownerId: number,
  telegramUserId: number,
  telegramChatId: number,
  migratedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE owners
       SET telegram_user_id = ?, telegram_chat_id = ?, migrated_at = ?
       WHERE id = ?`,
    )
    .bind(telegramUserId, telegramChatId, migratedAt, ownerId)
    .run();

  return result.meta.changes === 1;
}
