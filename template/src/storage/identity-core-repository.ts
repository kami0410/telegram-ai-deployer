export interface IdentityCandidate {
  id: number;
  identityKey: string;
  identityValue: string;
  status: "candidate" | "ready" | "promoted" | "rejected";
  evidenceCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface IdentityCoreEntry {
  id: number;
  identityKey: string;
  identityValue: string;
  version: number;
  updatedAt: number;
}

function clean(value: string, max: number): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, max);
}

function candidateRow(row: { id: number; identity_key: string; identity_value: string; status: IdentityCandidate["status"]; evidence_count: number; created_at: number; updated_at: number }): IdentityCandidate {
  return { id: row.id, identityKey: row.identity_key, identityValue: row.identity_value, status: row.status, evidenceCount: row.evidence_count, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function recordIdentityEvidence(db: D1Database, input: {
  ownerId: number; identityKey: string; identityValue: string; sourceMessageId: number; now: number;
}): Promise<IdentityCandidate> {
  const identityKey = clean(input.identityKey, 120).toLowerCase();
  const identityValue = clean(input.identityValue, 500);
  if (!identityKey || !identityValue) throw new Error("identity_candidate_invalid");
  const source = await db.prepare(
    `SELECT messages.id FROM messages JOIN conversations ON conversations.id = messages.conversation_id
     WHERE messages.id = ? AND messages.owner_id = ? AND conversations.owner_id = ? AND messages.role = 'user'`,
  ).bind(input.sourceMessageId, input.ownerId, input.ownerId).first();
  if (source === null) throw new Error("identity_evidence_requires_user_message");
  await db.prepare(
    `INSERT OR IGNORE INTO identity_candidates
       (owner_id, identity_key, identity_value, status, evidence_count, created_at, updated_at)
     VALUES (?, ?, ?, 'candidate', 0, ?, ?)`,
  ).bind(input.ownerId, identityKey, identityValue, input.now, input.now).run();
  const candidate = await db.prepare(
    `SELECT id FROM identity_candidates WHERE owner_id = ? AND identity_key = ? AND identity_value = ?`,
  ).bind(input.ownerId, identityKey, identityValue).first<{ id: number }>();
  if (candidate === null) throw new Error("identity_candidate_missing");
  await db.prepare(
    `INSERT OR IGNORE INTO identity_evidence (owner_id, candidate_id, source_message_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(input.ownerId, candidate.id, input.sourceMessageId, input.now).run();
  await db.prepare(
    `UPDATE identity_candidates SET evidence_count = (
       SELECT COUNT(*) FROM identity_evidence WHERE candidate_id = identity_candidates.id
     ), status = CASE WHEN status IN ('candidate','ready') AND (
       SELECT COUNT(*) FROM identity_evidence WHERE candidate_id = identity_candidates.id
     ) >= 2 THEN 'ready' ELSE status END, updated_at = ? WHERE id = ? AND owner_id = ?`,
  ).bind(input.now, candidate.id, input.ownerId).run();
  const row = await db.prepare(
    `SELECT id, identity_key, identity_value, status, evidence_count, created_at, updated_at
     FROM identity_candidates WHERE id = ? AND owner_id = ?`,
  ).bind(candidate.id, input.ownerId).first<Parameters<typeof candidateRow>[0]>();
  if (row === null) throw new Error("identity_candidate_missing");
  return candidateRow(row);
}

export async function listIdentityCandidates(db: D1Database, ownerId: number): Promise<IdentityCandidate[]> {
  const result = await db.prepare(
    `SELECT id, identity_key, identity_value, status, evidence_count, created_at, updated_at
     FROM identity_candidates WHERE owner_id = ? AND status IN ('candidate','ready')
     ORDER BY status = 'ready' DESC, evidence_count DESC, updated_at DESC`,
  ).bind(ownerId).all<Parameters<typeof candidateRow>[0]>();
  return result.results.map(candidateRow);
}

export async function getActiveIdentityCore(db: D1Database, ownerId: number): Promise<IdentityCoreEntry[]> {
  const result = await db.prepare(
    `SELECT id, identity_key, identity_value, version, updated_at FROM identity_core_entries
     WHERE owner_id = ? AND status = 'active' ORDER BY identity_key`,
  ).bind(ownerId).all<{ id: number; identity_key: string; identity_value: string; version: number; updated_at: number }>();
  return result.results.map((row) => ({ id: row.id, identityKey: row.identity_key, identityValue: row.identity_value, version: row.version, updatedAt: row.updated_at }));
}

export async function promoteIdentityCandidate(db: D1Database, ownerId: number, id: number, now: number): Promise<boolean> {
  const candidate = await db.prepare(
    `SELECT identity_key, identity_value FROM identity_candidates
     WHERE id = ? AND owner_id = ? AND status IN ('candidate','ready')`,
  ).bind(id, ownerId).first<{ identity_key: string; identity_value: string }>();
  if (candidate === null) return false;
  const previous = await db.prepare(
    `SELECT id, version FROM identity_core_entries WHERE owner_id = ? AND identity_key = ? AND status = 'active'`,
  ).bind(ownerId, candidate.identity_key).first<{ id: number; version: number }>();
  const nextVersion = (previous?.version ?? 0) + 1;
  const writes: D1PreparedStatement[] = [];
  if (previous !== null) writes.push(db.prepare("UPDATE identity_core_entries SET status = 'superseded', updated_at = ? WHERE id = ? AND owner_id = ?").bind(now, previous.id, ownerId));
  writes.push(db.prepare(
    `INSERT INTO identity_core_entries (owner_id, identity_key, identity_value, status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
  ).bind(ownerId, candidate.identity_key, candidate.identity_value, nextVersion, now, now));
  const result = await db.batch(writes);
  if (!result.every((entry) => entry.success)) throw new Error("identity_promote_failed");
  const created = await db.prepare(
    `SELECT id FROM identity_core_entries WHERE owner_id = ? AND identity_key = ? AND version = ?`,
  ).bind(ownerId, candidate.identity_key, nextVersion).first<{ id: number }>();
  if (created === null) throw new Error("identity_entry_missing");
  await db.batch([
    db.prepare("UPDATE identity_candidates SET status = 'promoted', resolved_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?").bind(now, now, id, ownerId),
    db.prepare(`INSERT INTO identity_core_history (owner_id, identity_key, previous_entry_id, new_entry_id, candidate_id, action, created_at) VALUES (?, ?, ?, ?, ?, 'promote', ?)`).bind(ownerId, candidate.identity_key, previous?.id ?? null, created.id, id, now),
  ]);
  return true;
}

export async function rejectIdentityCandidate(db: D1Database, ownerId: number, id: number, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE identity_candidates SET status = 'rejected', resolved_at = ?, updated_at = ?
     WHERE id = ? AND owner_id = ? AND status IN ('candidate','ready')`,
  ).bind(now, now, id, ownerId).run();
  return result.meta.changes === 1;
}

export async function revertIdentityCoreEntry(db: D1Database, ownerId: number, entryId: number, now: number): Promise<boolean> {
  const history = await db.prepare(
    `SELECT previous_entry_id, identity_key FROM identity_core_history
     WHERE owner_id = ? AND new_entry_id = ? AND action = 'promote'
     ORDER BY id DESC LIMIT 1`,
  ).bind(ownerId, entryId).first<{ previous_entry_id: number | null; identity_key: string }>();
  const active = await db.prepare(
    "SELECT id FROM identity_core_entries WHERE id = ? AND owner_id = ? AND status = 'active'",
  ).bind(entryId, ownerId).first();
  if (history === null || active === null) return false;
  const statements = [db.prepare(
    "UPDATE identity_core_entries SET status = 'superseded', updated_at = ? WHERE id = ? AND owner_id = ?",
  ).bind(now, entryId, ownerId)];
  if (history.previous_entry_id !== null) statements.push(db.prepare(
    "UPDATE identity_core_entries SET status = 'active', updated_at = ? WHERE id = ? AND owner_id = ?",
  ).bind(now, history.previous_entry_id, ownerId));
  statements.push(db.prepare(
    `INSERT INTO identity_core_history (owner_id, identity_key, previous_entry_id, new_entry_id, action, created_at)
     VALUES (?, ?, ?, ?, 'revert', ?)`,
  ).bind(ownerId, history.identity_key, entryId, history.previous_entry_id, now));
  const results = await db.batch(statements);
  return results.every((entry) => entry.success);
}
