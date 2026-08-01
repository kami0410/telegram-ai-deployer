import type { PromptMemoryFact } from "./prompt";
import {
  completeVectorSyncJob,
  failVectorSyncJob,
  loadSemanticRecords,
  type SemanticRecordReference,
  type VectorSyncJob,
} from "./storage/semantic-memory-repository";

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
const EMBEDDING_DIMENSIONS = 1_024;
const AUTOMATIC_MINIMUM_SCORE = 0.55;
const EXPLICIT_HISTORY_MINIMUM_SCORE = 0.45;

export interface EmbeddingAi {
  run(model: string, input: { text: string[] }): Promise<unknown>;
}

export interface MemoryVectorIndex {
  upsert(vectors: Array<{
    id: string;
    values: number[];
    namespace: string;
    metadata: Record<string, string | number | boolean>;
  }>): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(vector: number[], options: {
    topK: number;
    namespace: string;
    returnMetadata: "none";
  }): Promise<{ matches: Array<{ id: string; score?: number }> }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function embedTexts(
  ai: EmbeddingAi,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0 || texts.some((text) => text.length === 0)) {
    throw new Error("embedding_input_invalid");
  }
  const response = await ai.run(EMBEDDING_MODEL, { text: texts });
  if (!isRecord(response) || !Array.isArray(response.data) || response.data.length !== texts.length) {
    throw new Error("embedding_response_invalid");
  }
  const vectors = response.data.map((value) => {
    if (
      !Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS ||
      !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) throw new Error("embedding_dimensions_invalid");
    return value as number[];
  });
  return vectors;
}

function vectorId(kind: "fact" | "episode", id: number): string {
  return `${kind}:${id}`;
}

export async function syncVectorJob(
  db: D1Database,
  ai: EmbeddingAi,
  index: MemoryVectorIndex,
  job: VectorSyncJob,
  now: number,
): Promise<void> {
  const id = vectorId(job.entityKind, job.entityId);
  try {
    if (job.operation === "delete") {
      await index.deleteByIds([id]);
      await completeVectorSyncJob(db, job.jobId, now);
      return;
    }
    let text: string;
    let category: string;
    let occurredAt: number;
    if (job.entityKind === "fact") {
      const row = await db.prepare(
        `SELECT fact_key, fact_value, category, updated_at
         FROM memory_facts WHERE id = ? AND owner_id = ?
           AND NOT EXISTS (SELECT 1 FROM memory_controls
             WHERE owner_id = memory_facts.owner_id AND entity_kind = 'fact'
               AND entity_id = memory_facts.id AND control = 'ignored')`,
      ).bind(job.entityId, job.ownerId).first<{
        fact_key: string;
        fact_value: string;
        category: string;
        updated_at: number;
      }>();
      if (row === null) {
        await index.deleteByIds([id]);
        await completeVectorSyncJob(db, job.jobId, now);
        return;
      }
      text = `${row.fact_key} ${row.fact_value}`;
      category = row.category;
      occurredAt = row.updated_at;
    } else {
      const row = await db.prepare(
        `SELECT content, category, people_json, topics_json, occurred_at FROM memory_episodes
         WHERE id = ? AND owner_id = ? AND status = 'active'
           AND NOT EXISTS (SELECT 1 FROM memory_controls
             WHERE owner_id = memory_episodes.owner_id AND entity_kind = 'episode'
               AND entity_id = memory_episodes.id AND control = 'ignored')`,
      ).bind(job.entityId, job.ownerId).first<{
        content: string;
        category: string;
        people_json: string;
        topics_json: string;
        occurred_at: number;
      }>();
      if (row === null) {
        await index.deleteByIds([id]);
        await completeVectorSyncJob(db, job.jobId, now);
        return;
      }
      text = `${row.content} ${row.people_json} ${row.topics_json}`;
      category = row.category;
      occurredAt = row.occurred_at;
    }
    const [embedding] = await embedTexts(ai, [text]);
    await index.upsert([{
      id,
      values: embedding!,
      namespace: `owner:${job.ownerId}`,
      metadata: {
        owner_id: job.ownerId,
        kind: job.entityKind,
        category,
        occurred_at: occurredAt,
        active: true,
      },
    }]);
    await completeVectorSyncJob(db, job.jobId, now);
  } catch (error) {
    await failVectorSyncJob(
      db,
      job.jobId,
      error instanceof Error ? error.message : "vector_sync_failed",
      now,
    );
    throw error;
  }
}

function parseReference(id: string): SemanticRecordReference | null {
  const match = id.match(/^(fact|episode):(\d+)$/u);
  if (match === null) return null;
  const parsed = Number(match[2]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return { kind: match[1] as "fact" | "episode", id: parsed };
}

export async function getSemanticRelevantMemories(
  db: D1Database,
  ai: EmbeddingAi,
  index: MemoryVectorIndex,
  ownerId: number,
  query: string,
  now: number,
  explicitHistory: boolean,
): Promise<PromptMemoryFact[]> {
  try {
    const [embedding] = await embedTexts(ai, [query]);
    const matches = await index.query(embedding!, {
      topK: 20,
      namespace: `owner:${ownerId}`,
      returnMetadata: "none",
    });
    const scored = new Map<string, number>();
    const references: SemanticRecordReference[] = [];
    const minimumScore = explicitHistory
      ? EXPLICIT_HISTORY_MINIMUM_SCORE
      : AUTOMATIC_MINIMUM_SCORE;
    for (const match of matches.matches) {
      const score = typeof match.score === "number" ? match.score : 0;
      if (score < minimumScore) continue;
      const reference = parseReference(match.id);
      if (reference === null) continue;
      const key = `${reference.kind}:${reference.id}`;
      if (scored.has(key)) continue;
      scored.set(key, score);
      references.push(reference);
    }
    const loaded: PromptMemoryFact[] = [];
    for (const reference of references) {
      const [memory] = await loadSemanticRecords(
        db,
        ownerId,
        [reference],
        explicitHistory ? {} : { automaticOnlyAt: now },
      );
      if (memory === undefined) continue;
      loaded.push({
        ...memory,
        priorityScore: Math.round(
          (scored.get(`${reference.kind}:${reference.id}`) ?? 0) * 1_000,
        ),
      });
    }
    return loaded;
  } catch {
    return [];
  }
}
