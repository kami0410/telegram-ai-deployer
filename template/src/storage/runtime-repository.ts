export interface RuntimeState {
  ownerId: number;
  busyUntil: number | null;
  nextProactiveAt: number | null;
  updatedAt: number;
}

interface RuntimeRow {
  owner_id: number;
  busy_until: number | null;
  next_proactive_at: number | null;
  updated_at: number;
}

export async function getRuntimeState(
  db: D1Database,
  ownerId: number,
): Promise<RuntimeState | null> {
  const row = await db
    .prepare(
      `SELECT owner_id, busy_until, next_proactive_at, updated_at
       FROM persona_runtime_state WHERE owner_id = ?`,
    )
    .bind(ownerId)
    .first<RuntimeRow>();
  return row === null
    ? null
    : {
        ownerId: row.owner_id,
        busyUntil: row.busy_until,
        nextProactiveAt: row.next_proactive_at,
        updatedAt: row.updated_at,
      };
}

export async function setBusyUntil(
  db: D1Database,
  ownerId: number,
  busyUntil: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO persona_runtime_state (owner_id, busy_until, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         busy_until = excluded.busy_until,
         updated_at = excluded.updated_at`,
    )
    .bind(ownerId, busyUntil, now)
    .run();
}

export async function clearBusyIfDue(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE persona_runtime_state
       SET busy_until = NULL, updated_at = ?
       WHERE owner_id = ? AND busy_until IS NOT NULL AND busy_until <= ?`,
    )
    .bind(now, ownerId, now)
    .run();
  return result.meta.changes === 1;
}
