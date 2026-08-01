export type TimeMemoryLayer = "topic" | "week" | "month" | "relationship";

export interface TimeMemoryKeys {
  topic: string;
  week: string;
  month: string;
  relationship: "all";
}

export interface TimeMemoryUpdateContext {
  keys: TimeMemoryKeys;
  previous: Array<{
    layer: TimeMemoryLayer;
    periodKey: string;
    summary: string;
  }>;
}

export interface TimeMemoryInput {
  layer: TimeMemoryLayer;
  summary: string;
  topics: string[];
  importance: number;
}

export interface PromptTimeMemory {
  layer: TimeMemoryLayer;
  periodKey: string;
  summary: string;
  importance: number;
  updatedAt: number;
  priorityScore: number;
}

interface TimeMemoryRow {
  id: number;
  layer: TimeMemoryLayer;
  period_key: string;
  summary: string;
  topics_json: string;
  importance: number;
  updated_at: number;
}

const BEIJING_OFFSET_SECONDS = 8 * 3_600;
const LAYERS: TimeMemoryLayer[] = ["topic", "week", "month", "relationship"];

function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function timeMemoryKeys(conversationId: number, now: number): TimeMemoryKeys {
  const beijing = new Date((now + BEIJING_OFFSET_SECONDS) * 1_000);
  const weekStart = new Date(beijing);
  const daysSinceMonday = (beijing.getUTCDay() + 6) % 7;
  weekStart.setUTCDate(beijing.getUTCDate() - daysSinceMonday);
  return {
    topic: `conversation:${conversationId}`,
    week: formatDate(weekStart),
    month: `${beijing.getUTCFullYear()}-${String(beijing.getUTCMonth() + 1).padStart(2, "0")}`,
    relationship: "all",
  };
}

function parseTopics(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function relevanceScore(query: string, row: TimeMemoryRow): number {
  const normalized = query.toLocaleLowerCase();
  const candidate = `${row.summary} ${parseTopics(row.topics_json).join(" ")}`.toLocaleLowerCase();
  if (normalized.length > 0 && (candidate.includes(normalized) || normalized.includes(candidate))) {
    return 160;
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    if (candidate.includes(normalized.slice(index, index + 2))) return 90;
  }
  return 0;
}

function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  if (age <= 7 * 86_400) return 40;
  if (age <= 31 * 86_400) return 25;
  if (age <= 180 * 86_400) return 10;
  return 0;
}

export async function getTimeMemoryUpdateContext(
  db: D1Database,
  ownerId: number,
  conversationId: number,
  now: number,
): Promise<TimeMemoryUpdateContext> {
  const keys = timeMemoryKeys(conversationId, now);
  const result = await db.prepare(
    `SELECT layer, period_key, summary
     FROM memory_time_layers
     WHERE owner_id = ? AND (
       (layer = 'topic' AND period_key = ?) OR
       (layer = 'week' AND period_key = ?) OR
       (layer = 'month' AND period_key = ?) OR
       (layer = 'relationship' AND period_key = 'all')
     )`,
  ).bind(ownerId, keys.topic, keys.week, keys.month).all<{
    layer: TimeMemoryLayer;
    period_key: string;
    summary: string;
  }>();
  return {
    keys,
    previous: result.results.map((row) => ({
      layer: row.layer,
      periodKey: row.period_key,
      summary: row.summary,
    })),
  };
}

export async function saveTimeMemories(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    keys: TimeMemoryKeys;
    layers: TimeMemoryInput[];
    fromMessageId: number;
    throughMessageId: number;
    now: number;
  },
): Promise<void> {
  if (input.layers.length > LAYERS.length) throw new Error("too_many_time_memory_layers");
  const sources = await db.prepare(
    `SELECT COUNT(*) AS count FROM messages
     WHERE owner_id = ? AND conversation_id = ? AND role = 'user' AND id IN (?, ?)`,
  ).bind(
    input.ownerId,
    input.conversationId,
    input.fromMessageId,
    input.throughMessageId,
  ).first<{ count: number }>();
  const expectedSources = input.fromMessageId === input.throughMessageId ? 1 : 2;
  if (sources?.count !== expectedSources) throw new Error("time_memory_source_not_found");

  const statements: D1PreparedStatement[] = [];
  const seen = new Set<TimeMemoryLayer>();
  for (const layer of input.layers) {
    if (!LAYERS.includes(layer.layer) || seen.has(layer.layer)) {
      throw new Error("time_memory_layer_invalid");
    }
    seen.add(layer.layer);
    const summary = layer.summary.trim();
    if (summary.length === 0) continue;
    if (summary.length > 2_000) throw new Error("time_memory_summary_too_long");
    const topics = layer.topics
      .map((topic) => topic.trim())
      .filter((topic, index, values) => topic.length > 0 && values.indexOf(topic) === index)
      .slice(0, 10)
      .map((topic) => topic.slice(0, 100));
    const importance = Math.max(1, Math.min(5, Math.floor(layer.importance)));
    statements.push(db.prepare(
      `INSERT INTO memory_time_layers (
         owner_id, layer, period_key, summary, topics_json, importance,
         source_conversation_id, from_message_id, through_message_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, layer, period_key) DO UPDATE SET
         summary = excluded.summary,
         topics_json = excluded.topics_json,
         importance = excluded.importance,
         source_conversation_id = excluded.source_conversation_id,
         from_message_id = COALESCE(memory_time_layers.from_message_id, excluded.from_message_id),
         through_message_id = excluded.through_message_id,
         updated_at = excluded.updated_at`,
    ).bind(
      input.ownerId,
      layer.layer,
      input.keys[layer.layer],
      summary,
      JSON.stringify(topics),
      importance,
      input.conversationId,
      input.fromMessageId,
      input.throughMessageId,
      input.now,
      input.now,
    ));
  }
  if (statements.length === 0) return;
  const results = await db.batch(statements);
  if (!results.every((result) => result.success)) throw new Error("time_memory_save_failed");
}

export async function getRelevantTimeMemories(
  db: D1Database,
  ownerId: number,
  conversationId: number,
  query: string,
  now: number,
  limit = 6,
): Promise<PromptTimeMemory[]> {
  const keys = timeMemoryKeys(conversationId, now);
  const result = await db.prepare(
    `SELECT id, layer, period_key, summary, topics_json, importance, updated_at
     FROM memory_time_layers WHERE owner_id = ?
     ORDER BY updated_at DESC, id DESC LIMIT 40`,
  ).bind(ownerId).all<TimeMemoryRow>();
  const ranked = result.results
    .map((row) => {
      const relevance = relevanceScore(query, row);
      const currentPeriod =
        (row.layer === "topic" && row.period_key === keys.topic) ||
        (row.layer === "week" && row.period_key === keys.week) ||
        (row.layer === "month" && row.period_key === keys.month) ||
        row.layer === "relationship";
      const layerWeight = row.layer === "topic" ? 100
        : row.layer === "relationship" ? 80
        : row.layer === "week" ? 60
        : 40;
      return {
        row,
        relevance,
        currentPeriod,
        priorityScore:
          layerWeight + relevance + row.importance * 20 + recencyScore(row.updated_at, now),
      };
    })
    .filter((entry) => entry.currentPeriod || entry.relevance > 0)
    .sort((left, right) =>
      right.priorityScore - left.priorityScore || right.row.updated_at - left.row.updated_at
    )
    .slice(0, Math.max(0, Math.min(8, Math.floor(limit))));

  if (ranked.length > 0) {
    const updated = await db.batch(ranked.map((entry) =>
      db.prepare("UPDATE memory_time_layers SET last_used_at = ? WHERE id = ?")
        .bind(now, entry.row.id)
    ));
    if (!updated.every((entry) => entry.success)) throw new Error("time_memory_use_update_failed");
  }
  return ranked.map((entry) => ({
    layer: entry.row.layer,
    periodKey: entry.row.period_key,
    summary: entry.row.summary,
    importance: entry.row.importance,
    updatedAt: entry.row.updated_at,
    priorityScore: entry.priorityScore,
  }));
}
