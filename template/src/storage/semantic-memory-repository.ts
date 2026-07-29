import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryConfidence,
} from "../deepseek";
import type { PromptMemoryFact } from "../prompt";

const EPISODE_AUTO_INJECT_SECONDS = 30 * 86_400;
const CONFLICT_LIFETIME_SECONDS = 7 * 86_400;

export interface StableMemoryInput {
  category: MemoryCategory;
  factKey: string;
  factValue: string;
  confidence: MemoryConfidence;
  sourceMessageId: number;
}

export interface EpisodeMemoryInput {
  category: MemoryCategory;
  content: string;
  people: string[];
  topics: string[];
  occurredAt: number;
  sourceMessageId: number;
}

export interface SemanticRecordReference {
  kind: "fact" | "episode";
  id: number;
}

export interface MemoryConflictReference {
  conflictId: string;
  factKey: string;
  oldValue: string;
  newValue: string;
  expiresAt: number;
}

export interface VectorSyncJob {
  jobId: number;
  ownerId: number;
  entityKind: "fact" | "episode";
  entityId: number;
  operation: "upsert" | "delete";
  attemptCount: number;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

async function validateSource(
  db: D1Database,
  ownerId: number,
  conversationId: number,
  messageId: number,
): Promise<void> {
  const source = await db.prepare(
    `SELECT id FROM messages
     WHERE id = ? AND owner_id = ? AND conversation_id = ? AND role = 'user'`,
  ).bind(messageId, ownerId, conversationId).first();
  if (source === null) throw new Error("memory_source_not_found");
}

export async function queueMemoryVectorJob(
  db: D1Database,
  ownerId: number,
  kind: "fact" | "episode",
  entityId: number,
  operation: "upsert" | "delete",
  now: number,
): Promise<number> {
  await db.prepare(
    `INSERT INTO memory_vector_jobs (
       owner_id, entity_kind, entity_id, operation, status,
       attempt_count, last_error_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
     ON CONFLICT(owner_id, entity_kind, entity_id) DO UPDATE SET
       operation = excluded.operation,
       status = 'pending',
       attempt_count = 0,
       last_error_code = NULL,
       updated_at = excluded.updated_at`,
  ).bind(ownerId, kind, entityId, operation, now, now).run();
  const row = await db.prepare(
    `SELECT id FROM memory_vector_jobs
     WHERE owner_id = ? AND entity_kind = ? AND entity_id = ?`,
  ).bind(ownerId, kind, entityId).first<{ id: number }>();
  if (row === null) throw new Error("vector_job_missing");
  return row.id;
}

export async function saveMemoryExtraction(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    stableFacts: StableMemoryInput[];
    episodes: EpisodeMemoryInput[];
    now: number;
  },
): Promise<{
  records: SemanticRecordReference[];
  vectorJobIds: number[];
  conflicts: MemoryConflictReference[];
}> {
  if (input.stableFacts.length + input.episodes.length > 50) {
    throw new Error("too_many_memory_records");
  }
  const records: SemanticRecordReference[] = [];
  const vectorJobIds: number[] = [];
  const conflicts: MemoryConflictReference[] = [];

  for (const fact of input.stableFacts) {
    await validateSource(db, input.ownerId, input.conversationId, fact.sourceMessageId);
    const existing = await db.prepare(
      `SELECT id, fact_value FROM memory_facts WHERE owner_id = ? AND fact_key = ?`,
    ).bind(input.ownerId, fact.factKey).first<{ id: number; fact_value: string }>();
    if (existing === null) {
      const inserted = await db.prepare(
        `INSERT INTO memory_facts (
           owner_id, source_conversation_id, source_message_id, category,
           fact_key, fact_value, confidence, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      ).bind(
        input.ownerId,
        input.conversationId,
        fact.sourceMessageId,
        fact.category,
        fact.factKey,
        fact.factValue,
        fact.confidence,
        input.now,
        input.now,
      ).first<{ id: number }>();
      if (inserted === null) throw new Error("memory_fact_insert_failed");
      records.push({ kind: "fact", id: inserted.id });
      vectorJobIds.push(await queueMemoryVectorJob(db, input.ownerId, "fact", inserted.id, "upsert", input.now));
    } else if (existing.fact_value === fact.factValue) {
      await db.prepare(
        `UPDATE memory_facts SET source_conversation_id = ?, source_message_id = ?,
           category = ?, confidence = ?, updated_at = ? WHERE id = ?`,
      ).bind(
        input.conversationId,
        fact.sourceMessageId,
        fact.category,
        fact.confidence,
        input.now,
        existing.id,
      ).run();
      records.push({ kind: "fact", id: existing.id });
      vectorJobIds.push(await queueMemoryVectorJob(db, input.ownerId, "fact", existing.id, "upsert", input.now));
    } else {
      const conflictId = crypto.randomUUID();
      const expiresAt = input.now + CONFLICT_LIFETIME_SECONDS;
      await db.prepare(
        `INSERT INTO memory_conflicts (
           id, owner_id, existing_fact_id, source_conversation_id,
           source_message_id, candidate_category, candidate_fact_value,
           candidate_confidence, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, existing_fact_id, source_message_id, candidate_fact_value)
         DO NOTHING`,
      ).bind(
        conflictId,
        input.ownerId,
        existing.id,
        input.conversationId,
        fact.sourceMessageId,
        fact.category,
        fact.factValue,
        fact.confidence,
        expiresAt,
        input.now,
      ).run();
      const storedConflict = await db.prepare(
        `SELECT id, expires_at FROM memory_conflicts
         WHERE owner_id = ? AND existing_fact_id = ? AND source_message_id = ?
           AND candidate_fact_value = ?`,
      ).bind(
        input.ownerId,
        existing.id,
        fact.sourceMessageId,
        fact.factValue,
      ).first<{ id: string; expires_at: number }>();
      if (storedConflict === null) throw new Error("memory_conflict_insert_failed");
      conflicts.push({
        conflictId: storedConflict.id,
        factKey: fact.factKey,
        oldValue: existing.fact_value,
        newValue: fact.factValue,
        expiresAt: storedConflict.expires_at,
      });
    }
  }

  for (const episode of input.episodes) {
    await validateSource(db, input.ownerId, input.conversationId, episode.sourceMessageId);
    const inserted = await db.prepare(
      `INSERT INTO memory_episodes (
         owner_id, source_conversation_id, source_message_id, category,
         content, people_json, topics_json, occurred_at, auto_inject_until,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, source_message_id, content) DO UPDATE SET
         category = excluded.category,
         people_json = excluded.people_json,
         topics_json = excluded.topics_json,
         occurred_at = excluded.occurred_at,
         auto_inject_until = excluded.auto_inject_until,
         updated_at = excluded.updated_at
       RETURNING id`,
    ).bind(
      input.ownerId,
      input.conversationId,
      episode.sourceMessageId,
      episode.category,
      episode.content,
      JSON.stringify(episode.people),
      JSON.stringify(episode.topics),
      episode.occurredAt,
      input.now + EPISODE_AUTO_INJECT_SECONDS,
      input.now,
      input.now,
    ).first<{ id: number }>();
    if (inserted === null) throw new Error("memory_episode_insert_failed");
    records.push({ kind: "episode", id: inserted.id });
    vectorJobIds.push(await queueMemoryVectorJob(db, input.ownerId, "episode", inserted.id, "upsert", input.now));
  }
  return { records, vectorJobIds, conflicts };
}

export async function loadSemanticRecords(
  db: D1Database,
  ownerId: number,
  records: SemanticRecordReference[],
  options: { automaticOnlyAt?: number } = {},
): Promise<PromptMemoryFact[]> {
  const loaded: PromptMemoryFact[] = [];
  for (const record of records) {
    if (record.kind === "fact") {
      const row = await db.prepare(
        `SELECT fact_key, fact_value, category, confidence
         FROM memory_facts WHERE id = ? AND owner_id = ?`,
      ).bind(record.id, ownerId).first<{
        fact_key: string;
        fact_value: string;
        category: string;
        confidence: MemoryConfidence;
      }>();
      if (row !== null) loaded.push({
        factKey: row.fact_key,
        factValue: row.fact_value,
        category: row.category,
        confidence: row.confidence,
        priorityScore: 400,
      });
    } else {
      const row = await db.prepare(
        `SELECT content, category, people_json, topics_json, auto_inject_until
         FROM memory_episodes
         WHERE id = ? AND owner_id = ? AND status = 'active'`,
      ).bind(record.id, ownerId).first<{
        content: string;
        category: string;
        people_json: string;
        topics_json: string;
        auto_inject_until: number;
      }>();
      if (
        row !== null &&
        (options.automaticOnlyAt === undefined || row.auto_inject_until >= options.automaticOnlyAt)
      ) {
        const labels = [...parseStringArray(row.people_json), ...parseStringArray(row.topics_json)];
        loaded.push({
          factKey: `episode:${record.id}`,
          factValue: labels.length === 0 ? row.content : `${row.content}（${labels.join("、")}）`,
          category: row.category,
          confidence: "medium",
          priorityScore: 250,
        });
      }
    }
  }
  return loaded;
}

export async function resolveMemoryConflict(
  db: D1Database,
  ownerId: number,
  conflictId: string,
  resolution: "use_new" | "keep_old",
  now: number,
): Promise<{ ok: boolean; factId?: number; vectorJobId?: number }> {
  const conflict = await db.prepare(
    `SELECT existing_fact_id, source_conversation_id, source_message_id,
            candidate_category, candidate_fact_value, candidate_confidence
     FROM memory_conflicts
     WHERE id = ? AND owner_id = ? AND status = 'pending' AND expires_at >= ?`,
  ).bind(conflictId, ownerId, now).first<{
    existing_fact_id: number;
    source_conversation_id: number | null;
    source_message_id: number | null;
    candidate_category: string;
    candidate_fact_value: string;
    candidate_confidence: MemoryConfidence;
  }>();
  if (conflict === null) return { ok: false };
  if (resolution === "use_new") {
    await db.batch([
      db.prepare(
        `UPDATE memory_facts SET source_conversation_id = ?, source_message_id = ?,
           category = ?, fact_value = ?, confidence = ?, updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      ).bind(
        conflict.source_conversation_id,
        conflict.source_message_id,
        conflict.candidate_category,
        conflict.candidate_fact_value,
        conflict.candidate_confidence,
        now,
        conflict.existing_fact_id,
        ownerId,
      ),
      db.prepare(
        `UPDATE memory_conflicts SET status = 'use_new', resolved_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'pending'`,
      ).bind(now, conflictId, ownerId),
    ]);
    const vectorJobId = await queueMemoryVectorJob(
      db,
      ownerId,
      "fact",
      conflict.existing_fact_id,
      "upsert",
      now,
    );
    return { ok: true, factId: conflict.existing_fact_id, vectorJobId };
  }
  await db.prepare(
    `UPDATE memory_conflicts SET status = 'keep_old', resolved_at = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending'`,
  ).bind(now, conflictId, ownerId).run();
  return { ok: true, factId: conflict.existing_fact_id };
}

export async function getMemoryConflict(
  db: D1Database,
  ownerId: number,
  conflictId: string,
  now: number,
): Promise<{
  conflictId: string;
  factKey: string;
  existingFactValue: string;
  candidateCategory: string;
  candidateFactValue: string;
  candidateConfidence: MemoryConfidence;
  expiresAt: number;
} | null> {
  const row = await db.prepare(
    `SELECT memory_conflicts.id, memory_facts.fact_key,
            memory_facts.fact_value AS existing_fact_value,
            memory_conflicts.candidate_category,
            memory_conflicts.candidate_fact_value,
            memory_conflicts.candidate_confidence,
            memory_conflicts.expires_at
     FROM memory_conflicts
     JOIN memory_facts ON memory_facts.id = memory_conflicts.existing_fact_id
     WHERE memory_conflicts.id = ? AND memory_conflicts.owner_id = ?
       AND memory_conflicts.status = 'pending' AND memory_conflicts.expires_at >= ?`,
  ).bind(conflictId, ownerId, now).first<{
    id: string;
    fact_key: string;
    existing_fact_value: string;
    candidate_category: string;
    candidate_fact_value: string;
    candidate_confidence: MemoryConfidence;
    expires_at: number;
  }>();
  return row === null ? null : {
    conflictId: row.id,
    factKey: row.fact_key,
    existingFactValue: row.existing_fact_value,
    candidateCategory: row.candidate_category,
    candidateFactValue: row.candidate_fact_value,
    candidateConfidence: row.candidate_confidence,
    expiresAt: row.expires_at,
  };
}

export async function updateMemoryConflictCandidate(
  db: D1Database,
  ownerId: number,
  conflictId: string,
  input: {
    category: string;
    factValue: string;
    confidence: string;
    now: number;
  },
): Promise<boolean> {
  if (
    !MEMORY_CATEGORIES.some((category) => category === input.category) ||
    input.factValue.length === 0 || input.factValue.length > 1_000 ||
    (input.confidence !== "low" && input.confidence !== "medium" && input.confidence !== "high")
  ) throw new Error("memory_conflict_candidate_invalid");
  const result = await db.prepare(
    `UPDATE memory_conflicts SET candidate_category = ?, candidate_fact_value = ?,
       candidate_confidence = ?
     WHERE id = ? AND owner_id = ? AND status = 'pending' AND expires_at >= ?`,
  ).bind(
    input.category,
    input.factValue,
    input.confidence,
    conflictId,
    ownerId,
    input.now,
  ).run();
  return result.meta.changes === 1;
}

export async function queueFullVectorRebuild(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<number> {
  const facts = await db.prepare(
    "SELECT id FROM memory_facts WHERE owner_id = ?",
  ).bind(ownerId).all<{ id: number }>();
  const episodes = await db.prepare(
    "SELECT id FROM memory_episodes WHERE owner_id = ? AND status = 'active'",
  ).bind(ownerId).all<{ id: number }>();
  for (const row of facts.results) await queueMemoryVectorJob(db, ownerId, "fact", row.id, "upsert", now);
  for (const row of episodes.results) await queueMemoryVectorJob(db, ownerId, "episode", row.id, "upsert", now);
  return facts.results.length + episodes.results.length;
}

export async function claimVectorSyncJob(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<VectorSyncJob | null> {
  const row = await db.prepare(
    `SELECT id, entity_kind, entity_id, operation, attempt_count
     FROM memory_vector_jobs
     WHERE owner_id = ? AND status IN ('pending', 'failed')
     ORDER BY updated_at, id LIMIT 1`,
  ).bind(ownerId).first<{
    id: number;
    entity_kind: "fact" | "episode";
    entity_id: number;
    operation: "upsert" | "delete";
    attempt_count: number;
  }>();
  if (row === null) return null;
  const result = await db.prepare(
    `UPDATE memory_vector_jobs SET status = 'processing',
       attempt_count = attempt_count + 1, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'failed')`,
  ).bind(now, row.id).run();
  if (result.meta.changes !== 1) return null;
  return {
    jobId: row.id,
    ownerId,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    operation: row.operation,
    attemptCount: row.attempt_count + 1,
  };
}

export async function completeVectorSyncJob(
  db: D1Database,
  jobId: number,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE memory_vector_jobs SET status = 'completed', last_error_code = NULL,
       updated_at = ? WHERE id = ? AND status = 'processing'`,
  ).bind(now, jobId).run();
}

export async function failVectorSyncJob(
  db: D1Database,
  jobId: number,
  errorCode: string,
  now: number,
): Promise<void> {
  await db.prepare(
    `UPDATE memory_vector_jobs SET status = 'failed', last_error_code = ?,
       updated_at = ? WHERE id = ? AND status = 'processing'`,
  ).bind(errorCode.slice(0, 100), now, jobId).run();
}
