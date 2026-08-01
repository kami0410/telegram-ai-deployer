export type MemoryEntityKind = "fact" | "episode";
export type MemoryControl = "normal" | "pinned" | "ignored";

export async function setMemoryControl(
  db: D1Database,
  ownerId: number,
  kind: MemoryEntityKind,
  entityId: number,
  control: MemoryControl,
  now: number,
): Promise<boolean> {
  const table = kind === "fact" ? "memory_facts" : "memory_episodes";
  const exists = await db.prepare(
    `SELECT id FROM ${table} WHERE id = ? AND owner_id = ?`,
  ).bind(entityId, ownerId).first();
  if (exists === null) return false;
  const operation = control === "ignored" ? "delete" : "upsert";
  const results = await db.batch([
    db.prepare(
      `INSERT INTO memory_controls (owner_id, entity_kind, entity_id, control, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, entity_kind, entity_id) DO UPDATE SET
         control = excluded.control, updated_at = excluded.updated_at`,
    ).bind(ownerId, kind, entityId, control, now),
    db.prepare(
      `INSERT INTO memory_vector_jobs (
         owner_id, entity_kind, entity_id, operation, status,
         attempt_count, last_error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
       ON CONFLICT(owner_id, entity_kind, entity_id) DO UPDATE SET
         operation = excluded.operation, status = 'pending', attempt_count = 0,
         last_error_code = NULL, updated_at = excluded.updated_at`,
    ).bind(ownerId, kind, entityId, operation, now, now),
  ]);
  if (!results.every((result) => result.success)) throw new Error("memory_control_update_failed");
  return true;
}
