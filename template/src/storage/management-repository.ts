import { MEMORY_CATEGORIES, type MemoryConfidence } from "../deepseek";

const MAX_PAGE_SIZE = 50;

export interface ManagedMemory {
  id: number;
  category: string;
  factKey: string;
  factValue: string;
  confidence: MemoryConfidence;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryPage {
  items: ManagedMemory[];
  nextCursor: string | null;
}

export interface MemoryListOptions {
  query?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}

export interface ManagementOverview {
  currentPersonaVersion: number | null;
  personaUpdatedAt: number | null;
  pendingDraftCount: number;
  memoryCount: number;
  memoryByCategory: Record<string, number>;
}

export interface PersonaVersionSummary {
  version: number;
  changeSummary: string;
  snapshot: unknown;
  createdAt: number;
  current: boolean;
}

export interface ManagedPersonaDraft {
  id: string;
  operation: "correction" | "addition";
  summary: string;
  impactScope: string;
  patch: unknown;
  sourceMessageId: number | null;
  expiresAt: number;
  createdAt: number;
}

interface MemoryRow {
  id: number;
  category: string;
  fact_key: string;
  fact_value: string;
  confidence: MemoryConfidence;
  created_at: number;
  updated_at: number;
}

function isMemoryConfidence(value: string): value is MemoryConfidence {
  return value === "low" || value === "medium" || value === "high";
}

function isCategory(value: string): boolean {
  return MEMORY_CATEGORIES.some((category) => category === value);
}

function encodeCursor(updatedAt: number, id: number): string {
  return btoa(`${updatedAt}:${id}`);
}

function decodeCursor(value: string | undefined): [number, number] | null {
  if (value === undefined || value.length === 0) return null;
  try {
    const match = atob(value).match(/^(\d+):(\d+)$/u);
    if (match === null) return null;
    const updatedAt = Number(match[1]);
    const id = Number(match[2]);
    return Number.isSafeInteger(updatedAt) && Number.isSafeInteger(id)
      ? [updatedAt, id]
      : null;
  } catch {
    return null;
  }
}

function toManagedMemory(row: MemoryRow): ManagedMemory {
  return {
    id: row.id,
    category: row.category,
    factKey: row.fact_key,
    factValue: row.fact_value,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMemories(
  db: D1Database,
  ownerId: number,
  options: MemoryListOptions = {},
): Promise<MemoryPage> {
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(options.limit ?? 20)));
  if (options.category !== undefined && !isCategory(options.category)) {
    throw new Error("memory_category_invalid");
  }
  const cursor = decodeCursor(options.cursor);
  if (options.cursor !== undefined && cursor === null) {
    throw new Error("memory_cursor_invalid");
  }
  const clauses = ["owner_id = ?"];
  const binds: unknown[] = [ownerId];
  if (options.category !== undefined) {
    clauses.push("category = ?");
    binds.push(options.category);
  }
  const query = options.query?.trim();
  if (query !== undefined && query.length > 0) {
    if (query.length > 200) throw new Error("memory_query_too_long");
    clauses.push("(fact_key LIKE ? OR fact_value LIKE ?)");
    binds.push(`%${query}%`, `%${query}%`);
  }
  if (cursor !== null) {
    clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  const result = await db.prepare(
    `SELECT id, category, fact_key, fact_value, confidence, created_at, updated_at
     FROM memory_facts WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<MemoryRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map(toManagedMemory),
    nextCursor: result.results.length > limit && last !== undefined
      ? encodeCursor(last.updated_at, last.id)
      : null,
  };
}

export async function updateMemory(
  db: D1Database,
  ownerId: number,
  memoryId: number,
  input: {
    category: string;
    factValue: string;
    confidence: string;
    expectedUpdatedAt: number;
    now: number;
  },
): Promise<{ ok: true; updatedAt: number } | { ok: false; reason: "not_found_or_conflict" }> {
  if (!isCategory(input.category)) throw new Error("memory_category_invalid");
  if (!isMemoryConfidence(input.confidence)) throw new Error("memory_confidence_invalid");
  const factValue = input.factValue.trim();
  if (factValue.length === 0 || factValue.length > 1_000) {
    throw new Error("memory_value_invalid");
  }
  const results = await db.batch([
    db.prepare(
      `UPDATE memory_facts SET category = ?, fact_value = ?, confidence = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND updated_at = ?`,
    ).bind(
      input.category,
      factValue,
      input.confidence,
      input.now,
      memoryId,
      ownerId,
      input.expectedUpdatedAt,
    ),
    db.prepare(
      `INSERT INTO memory_vector_jobs (
         owner_id, entity_kind, entity_id, operation, status,
         attempt_count, last_error_code, created_at, updated_at
       )
       SELECT ?, 'fact', ?, 'upsert', 'pending', 0, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM memory_facts
         WHERE id = ? AND owner_id = ? AND updated_at = ?
           AND category = ? AND fact_value = ? AND confidence = ?
       )
       ON CONFLICT(owner_id, entity_kind, entity_id) DO UPDATE SET
         operation = 'upsert', status = 'pending', attempt_count = 0,
         last_error_code = NULL, updated_at = excluded.updated_at`,
    ).bind(
      ownerId,
      memoryId,
      input.now,
      input.now,
      memoryId,
      ownerId,
      input.now,
      input.category,
      factValue,
      input.confidence,
    ),
  ]);
  if (!results.every((result) => result.success)) throw new Error("memory_update_failed");
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    return { ok: false, reason: "not_found_or_conflict" };
  }
  return { ok: true, updatedAt: input.now };
}

export async function deleteMemory(
  db: D1Database,
  ownerId: number,
  memoryId: number,
  expectedUpdatedAt: number,
  now: number,
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(
      `INSERT INTO memory_vector_jobs (
         owner_id, entity_kind, entity_id, operation, status,
         attempt_count, last_error_code, created_at, updated_at
       )
       SELECT ?, 'fact', ?, 'delete', 'pending', 0, NULL, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM memory_facts
         WHERE id = ? AND owner_id = ? AND updated_at = ?
       )
       ON CONFLICT(owner_id, entity_kind, entity_id) DO UPDATE SET
         operation = 'delete', status = 'pending', attempt_count = 0,
         last_error_code = NULL, updated_at = excluded.updated_at`,
    ).bind(ownerId, memoryId, now, now, memoryId, ownerId, expectedUpdatedAt),
    db.prepare(
      "DELETE FROM memory_facts WHERE id = ? AND owner_id = ? AND updated_at = ?",
    ).bind(memoryId, ownerId, expectedUpdatedAt),
  ]);
  if (!results.every((result) => result.success)) throw new Error("memory_delete_failed");
  if ((results[1]?.meta.changes ?? 0) !== 1) return false;
  return true;
}

export async function getManagementOverview(
  db: D1Database,
  ownerId: number,
): Promise<ManagementOverview> {
  const [profile, draft, categories] = await Promise.all([
    db.prepare(
      "SELECT current_version, updated_at FROM persona_profiles WHERE owner_id = ?",
    ).bind(ownerId).first<{ current_version: number; updated_at: number }>(),
    db.prepare(
      "SELECT COUNT(*) AS count FROM persona_change_drafts WHERE owner_id = ?",
    ).bind(ownerId).first<{ count: number }>(),
    db.prepare(
      "SELECT category, COUNT(*) AS count FROM memory_facts WHERE owner_id = ? GROUP BY category",
    ).bind(ownerId).all<{ category: string; count: number }>(),
  ]);
  const memoryByCategory = Object.fromEntries(
    categories.results.map((row) => [row.category, row.count]),
  );
  return {
    currentPersonaVersion: profile?.current_version ?? null,
    personaUpdatedAt: profile?.updated_at ?? null,
    pendingDraftCount: draft?.count ?? 0,
    memoryCount: categories.results.reduce((sum, row) => sum + row.count, 0),
    memoryByCategory,
  };
}

export async function listPersonaVersions(
  db: D1Database,
  ownerId: number,
  limit = 50,
): Promise<PersonaVersionSummary[]> {
  const result = await db.prepare(
    `SELECT persona_versions.version, persona_versions.change_summary,
            persona_versions.snapshot_json, persona_versions.created_at,
            persona_profiles.current_version
     FROM persona_versions JOIN persona_profiles
       ON persona_profiles.owner_id = persona_versions.owner_id
     WHERE persona_versions.owner_id = ?
     ORDER BY persona_versions.version DESC LIMIT ?`,
  ).bind(ownerId, Math.max(1, Math.min(100, Math.floor(limit)))).all<{
    version: number;
    change_summary: string;
    snapshot_json: string;
    created_at: number;
    current_version: number;
  }>();
  return result.results.map((row) => ({
    version: row.version,
    changeSummary: row.change_summary,
    snapshot: JSON.parse(row.snapshot_json) as unknown,
    createdAt: row.created_at,
    current: row.version === row.current_version,
  }));
}

export async function listPersonaDrafts(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<ManagedPersonaDraft[]> {
  const result = await db.prepare(
    `SELECT id, operation, summary, impact_scope, patch_json,
            source_message_id, expires_at, created_at
     FROM persona_change_drafts
     WHERE owner_id = ? AND expires_at >= ? ORDER BY created_at DESC`,
  ).bind(ownerId, now).all<{
    id: string;
    operation: "correction" | "addition";
    summary: string;
    impact_scope: string;
    patch_json: string;
    source_message_id: number | null;
    expires_at: number;
    created_at: number;
  }>();
  return result.results.map((row) => ({
    id: row.id,
    operation: row.operation,
    summary: row.summary,
    impactScope: row.impact_scope,
    patch: JSON.parse(row.patch_json) as unknown,
    sourceMessageId: row.source_message_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export async function cancelPersonaDraft(
  db: D1Database,
  ownerId: number,
  draftId: string,
): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM persona_change_drafts WHERE id = ? AND owner_id = ?",
  ).bind(draftId, ownerId).run();
  return result.meta.changes === 1;
}

export async function recordManagementEvent(
  db: D1Database,
  input: {
    ownerId: number;
    action: string;
    resourceType: string;
    resourceId: string;
    result: string;
    now: number;
  },
): Promise<void> {
  for (const value of [input.action, input.resourceType, input.resourceId, input.result]) {
    if (value.length === 0 || value.length > 100) throw new Error("management_event_invalid");
  }
  await db.prepare(
    `INSERT INTO management_events (
       owner_id, action, resource_type, resource_id, result, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.ownerId,
    input.action,
    input.resourceType,
    input.resourceId,
    input.result,
    input.now,
  ).run();
}
