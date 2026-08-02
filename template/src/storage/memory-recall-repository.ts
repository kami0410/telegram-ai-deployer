import type { RankedMemoryCandidate } from "../memory-reranker";

export interface MemoryRecallTraceListItem {
  id: number;
  conversationId: number | null;
  assistantMessageId: number | null;
  explicitHistory: boolean;
  model: string;
  personaVersion: number;
  itemCount: number;
  createdAt: number;
}

export interface MemoryRecallTrace extends MemoryRecallTraceListItem {
  queryHash: string;
  items: Array<{
    entityKind: RankedMemoryCandidate["entityKind"];
    entityId: number;
    factKey: string;
    factValue: string;
    category: string;
    confidence: RankedMemoryCandidate["confidence"];
    sourceMessageId: number | null;
    channel: RankedMemoryCandidate["channel"];
    totalScore: number;
    components: RankedMemoryCandidate["components"];
    reasonCodes: string[];
  }>;
}

function parseReasonCodes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

export async function saveRecallTrace(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    assistantMessageId: number;
    queryHash: string;
    explicitHistory: boolean;
    model: string;
    personaVersion: number;
    items: RankedMemoryCandidate[];
    now: number;
  },
): Promise<number> {
  if (!/^[a-f0-9]{64}$/u.test(input.queryHash)) throw new Error("recall_query_hash_invalid");
  const items = input.items.slice(0, 30);
  const trace = await db.prepare(
    `INSERT INTO memory_recall_traces (
       owner_id, conversation_id, assistant_message_id, query_hash,
       explicit_history, model, persona_version, item_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(
    input.ownerId,
    input.conversationId,
    input.assistantMessageId,
    input.queryHash,
    input.explicitHistory ? 1 : 0,
    input.model.slice(0, 120),
    Math.max(0, Math.floor(input.personaVersion)),
    items.length,
    input.now,
  ).first<{ id: number }>();
  if (trace === null) throw new Error("recall_trace_insert_failed");
  if (items.length > 0) {
    const results = await db.batch(items.map((item) => db.prepare(
      `INSERT INTO memory_recall_items (
         owner_id, trace_id, entity_kind, entity_id, fact_key, fact_value,
         category, confidence, source_message_id, channel, total_score,
         relevance_score, confidence_score, recency_score, control_score,
         channel_score, diversity_score, reason_codes_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.ownerId,
      trace.id,
      item.entityKind,
      item.entityId,
      item.factKey.slice(0, 160),
      item.factValue.slice(0, 1_000),
      item.category.slice(0, 80),
      item.confidence,
      item.sourceMessageId ?? null,
      item.channel,
      item.totalScore,
      item.components.relevance,
      item.components.confidence,
      item.components.recency,
      item.components.control,
      item.components.channel,
      item.components.diversity,
      JSON.stringify(item.reasonCodes.slice(0, 10)),
      input.now,
    )));
    if (!results.every((result) => result.success)) throw new Error("recall_items_insert_failed");
  }
  return trace.id;
}

export async function listRecallTraces(
  db: D1Database,
  ownerId: number,
  limit = 20,
): Promise<MemoryRecallTraceListItem[]> {
  const result = await db.prepare(
    `SELECT id, conversation_id, assistant_message_id, explicit_history,
            model, persona_version, item_count, created_at
     FROM memory_recall_traces WHERE owner_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(ownerId, Math.max(1, Math.min(100, Math.floor(limit))))
    .all<{
      id: number;
      conversation_id: number | null;
      assistant_message_id: number | null;
      explicit_history: number;
      model: string;
      persona_version: number;
      item_count: number;
      created_at: number;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    assistantMessageId: row.assistant_message_id,
    explicitHistory: row.explicit_history === 1,
    model: row.model,
    personaVersion: row.persona_version,
    itemCount: row.item_count,
    createdAt: row.created_at,
  }));
}

export async function getRecallTrace(
  db: D1Database,
  ownerId: number,
  traceId: number,
): Promise<MemoryRecallTrace | null> {
  const trace = await db.prepare(
    `SELECT id, conversation_id, assistant_message_id, query_hash, explicit_history,
            model, persona_version, item_count, created_at
     FROM memory_recall_traces WHERE id = ? AND owner_id = ?`,
  ).bind(traceId, ownerId).first<{
    id: number;
    conversation_id: number | null;
    assistant_message_id: number | null;
    query_hash: string;
    explicit_history: number;
    model: string;
    persona_version: number;
    item_count: number;
    created_at: number;
  }>();
  if (trace === null) return null;
  const items = await db.prepare(
    `SELECT entity_kind, entity_id, fact_key, fact_value, category, confidence,
            source_message_id, channel, total_score, relevance_score,
            confidence_score, recency_score, control_score, channel_score,
            diversity_score, reason_codes_json
     FROM memory_recall_items WHERE owner_id = ? AND trace_id = ?
     ORDER BY total_score DESC, id`,
  ).bind(ownerId, traceId).all<{
    entity_kind: RankedMemoryCandidate["entityKind"];
    entity_id: number;
    fact_key: string;
    fact_value: string;
    category: string;
    confidence: RankedMemoryCandidate["confidence"];
    source_message_id: number | null;
    channel: RankedMemoryCandidate["channel"];
    total_score: number;
    relevance_score: number;
    confidence_score: number;
    recency_score: number;
    control_score: number;
    channel_score: number;
    diversity_score: number;
    reason_codes_json: string;
  }>();
  return {
    id: trace.id,
    conversationId: trace.conversation_id,
    assistantMessageId: trace.assistant_message_id,
    queryHash: trace.query_hash,
    explicitHistory: trace.explicit_history === 1,
    model: trace.model,
    personaVersion: trace.persona_version,
    itemCount: trace.item_count,
    createdAt: trace.created_at,
    items: items.results.map((item) => ({
      entityKind: item.entity_kind,
      entityId: item.entity_id,
      factKey: item.fact_key,
      factValue: item.fact_value,
      category: item.category,
      confidence: item.confidence,
      sourceMessageId: item.source_message_id,
      channel: item.channel,
      totalScore: item.total_score,
      components: {
        relevance: item.relevance_score,
        confidence: item.confidence_score,
        recency: item.recency_score,
        control: item.control_score,
        channel: item.channel_score,
        diversity: item.diversity_score,
      },
      reasonCodes: parseReasonCodes(item.reason_codes_json),
    })),
  };
}
