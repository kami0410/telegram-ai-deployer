export interface ReminderRecord {
  id: string;
  ownerId: number;
  code: string;
  content: string;
  dueAt: number;
  status: "pending" | "sent" | "cancelled" | "failed";
  workflowInstanceId: string | null;
  claimedAt: number | null;
}

interface ReminderRow {
  id: string;
  owner_id: number;
  code: string;
  content: string;
  due_at: number;
  status: ReminderRecord["status"];
  workflow_instance_id: string | null;
  claimed_at: number | null;
}

function map(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    code: row.code,
    content: row.content,
    dueAt: row.due_at,
    status: row.status,
    workflowInstanceId: row.workflow_instance_id,
    claimedAt: row.claimed_at,
  };
}

export async function createReminder(
  db: D1Database,
  input: { ownerId: number; content: string; dueAt: number; now: number },
): Promise<ReminderRecord> {
  const id = crypto.randomUUID();
  const code = id.replaceAll("-", "").slice(0, 8);
  const row = await db.prepare(
    `INSERT INTO reminders (
       id, owner_id, code, content, due_at, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
     RETURNING id, owner_id, code, content, due_at, status, workflow_instance_id, claimed_at`,
  ).bind(id, input.ownerId, code, input.content, input.dueAt, input.now, input.now)
    .first<ReminderRow>();
  if (row === null) throw new Error("reminder_create_failed");
  return map(row);
}

export async function setReminderWorkflowInstance(
  db: D1Database,
  reminderId: string,
  ownerId: number,
  workflowInstanceId: string,
  now: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE reminders SET workflow_instance_id = ?, updated_at = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending'`,
  ).bind(workflowInstanceId, now, reminderId, ownerId).run();
  return result.meta.changes === 1;
}

export async function listPendingReminders(
  db: D1Database,
  ownerId: number,
  limit: number,
): Promise<ReminderRecord[]> {
  const rows = await db.prepare(
    `SELECT id, owner_id, code, content, due_at, status, workflow_instance_id, claimed_at
     FROM reminders WHERE owner_id = ? AND status = 'pending'
     ORDER BY due_at, created_at LIMIT ?`,
  ).bind(ownerId, limit).all<ReminderRow>();
  return rows.results.map(map);
}

export async function getPendingReminder(
  db: D1Database,
  reminderId: string,
  ownerId: number,
): Promise<ReminderRecord | null> {
  const row = await db.prepare(
    `SELECT id, owner_id, code, content, due_at, status, workflow_instance_id, claimed_at
     FROM reminders WHERE id = ? AND owner_id = ? AND status = 'pending'`,
  ).bind(reminderId, ownerId).first<ReminderRow>();
  return row === null ? null : map(row);
}

export async function markReminderSent(
  db: D1Database,
  reminderId: string,
  ownerId: number,
  now: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE reminders SET status = 'sent', sent_at = ?, updated_at = ?,
       claimed_at = NULL, last_error = NULL
     WHERE id = ? AND owner_id = ? AND status = 'pending'`,
  ).bind(now, now, reminderId, ownerId).run();
  return result.meta.changes === 1;
}

export async function claimReminderDelivery(
  db: D1Database,
  reminderId: string,
  ownerId: number,
  now: number,
): Promise<ReminderRecord | null> {
  const result = await db.prepare(
    `UPDATE reminders SET claimed_at = ?, delivery_attempts = delivery_attempts + 1,
       updated_at = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending' AND claimed_at IS NULL`,
  ).bind(now, now, reminderId, ownerId).run();
  if (result.meta.changes !== 1) return null;
  return getPendingReminder(db, reminderId, ownerId);
}

export async function releaseReminderClaim(
  db: D1Database,
  reminderId: string,
  ownerId: number,
  claimedAt: number,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE reminders SET claimed_at = NULL, updated_at = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending' AND claimed_at = ?`,
  ).bind(now, reminderId, ownerId, claimedAt).run();
}

export async function releaseStaleReminderClaims(
  db: D1Database,
  now: number,
  staleAfterSeconds = 10 * 60,
): Promise<Array<{ reminderId: string; ownerId: number }>> {
  const result = await db.prepare(
    `UPDATE reminders SET claimed_at = NULL,
       last_error = 'ambiguous_delivery_retry', updated_at = ?
     WHERE status = 'pending' AND claimed_at IS NOT NULL AND claimed_at <= ?
     RETURNING id, owner_id`,
  ).bind(now, now - staleAfterSeconds).all<{ id: string; owner_id: number }>();
  return result.results.map((row) => ({
    reminderId: row.id,
    ownerId: row.owner_id,
  }));
}

export async function cancelReminder(
  db: D1Database,
  ownerId: number,
  code: string,
  now: number,
): Promise<"cancelled" | "too_late" | "already_done" | "not_found"> {
  const row = await db.prepare(
    `SELECT status FROM reminders WHERE owner_id = ? AND code = ?`,
  ).bind(ownerId, code).first<{ status: ReminderRecord["status"] }>();
  if (row === null) return "not_found";
  if (row.status !== "pending") return "already_done";
  const reminder = await getReminderByCode(db, ownerId, code);
  if (reminder?.claimedAt !== null) return "too_late";
  const result = await db.prepare(
    `UPDATE reminders SET status = 'cancelled', cancelled_at = ?, updated_at = ?
     WHERE owner_id = ? AND code = ? AND status = 'pending' AND claimed_at IS NULL`,
  ).bind(now, now, ownerId, code).run();
  return result.meta.changes === 1 ? "cancelled" : "already_done";
}

export async function getReminderByCode(
  db: D1Database,
  ownerId: number,
  code: string,
): Promise<ReminderRecord | null> {
  const row = await db.prepare(
    `SELECT id, owner_id, code, content, due_at, status, workflow_instance_id, claimed_at
     FROM reminders WHERE owner_id = ? AND code = ?`,
  ).bind(ownerId, code).first<ReminderRow>();
  return row === null ? null : map(row);
}
