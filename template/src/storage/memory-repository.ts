import {
  MEMORY_CATEGORIES,
  type ExtractedMemoryFact,
  type MemoryConfidence,
} from "../deepseek";
import type { PromptMemoryFact } from "../prompt";

interface MemoryFactRow {
  id: number;
  category: string;
  fact_key: string;
  fact_value: string;
  confidence: MemoryConfidence;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

function confidenceScore(confidence: MemoryConfidence): number {
  switch (confidence) {
    case "high":
      return 300;
    case "medium":
      return 200;
    case "low":
      return 100;
  }
}

function topicScore(query: string, row: MemoryFactRow): number {
  const normalizedQuery = query.toLocaleLowerCase();
  const candidate = `${row.fact_key} ${row.fact_value}`.toLocaleLowerCase();
  if (candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate)) {
    return 120;
  }
  for (let index = 0; index < normalizedQuery.length - 1; index += 1) {
    if (candidate.includes(normalizedQuery.slice(index, index + 2))) return 80;
  }
  return 0;
}

function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  if (age <= 7 * 86_400) return 30;
  if (age <= 30 * 86_400) return 20;
  if (age <= 180 * 86_400) return 10;
  return 0;
}

function isAllowedCategory(category: string): boolean {
  return MEMORY_CATEGORIES.some((allowed) => allowed === category);
}

export async function upsertMemoryFacts(
  db: D1Database,
  ownerId: number,
  conversationId: number,
  facts: ExtractedMemoryFact[],
  now: number,
): Promise<void> {
  if (facts.length > 50) throw new Error("too_many_memory_facts");
  const statements: D1PreparedStatement[] = [];
  for (const fact of facts) {
    if (!isAllowedCategory(fact.category)) {
      throw new Error("memory_category_invalid");
    }
    const source = await db
      .prepare(
        `SELECT id FROM messages
         WHERE id = ? AND owner_id = ? AND conversation_id = ? AND role = 'user'`,
      )
      .bind(fact.sourceMessageId, ownerId, conversationId)
      .first<{ id: number }>();
    if (source === null) throw new Error("memory_source_not_found");

    statements.push(
      db
        .prepare(
          `INSERT INTO memory_facts (
             owner_id, source_conversation_id, source_message_id,
             category, fact_key, fact_value, confidence, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(owner_id, fact_key) DO UPDATE SET
             source_conversation_id = excluded.source_conversation_id,
             source_message_id = excluded.source_message_id,
             category = excluded.category,
             fact_value = excluded.fact_value,
             confidence = excluded.confidence,
             updated_at = excluded.updated_at`,
        )
        .bind(
          ownerId,
          conversationId,
          fact.sourceMessageId,
          fact.category,
          fact.factKey,
          fact.factValue,
          fact.confidence,
          now,
          now,
        ),
    );
  }
  if (statements.length === 0) return;
  const results = await db.batch(statements);
  if (!results.every((result) => result.success && result.meta.changes === 1)) {
    throw new Error("memory_upsert_failed");
  }
}

export async function getRelevantMemoryFacts(
  db: D1Database,
  ownerId: number,
  query: string,
  limit: number,
  now: number,
): Promise<PromptMemoryFact[]> {
  const result = await db
    .prepare(
      `SELECT id, category, fact_key, fact_value, confidence,
              created_at, updated_at, last_used_at
       FROM memory_facts
       WHERE owner_id = ?
       ORDER BY updated_at DESC, id ASC
       LIMIT 200`,
    )
    .bind(ownerId)
    .all<MemoryFactRow>();
  const safeLimit = Math.max(0, Math.min(50, Math.floor(limit)));
  const ranked = result.results
    .map((row) => {
      const topic = topicScore(query, row);
      return {
        id: row.id,
        factKey: row.fact_key,
        factValue: row.fact_value,
        category: row.category,
        confidence: row.confidence,
        topic,
        priorityScore:
          confidenceScore(row.confidence) +
          topic +
          recencyScore(row.updated_at, now) +
          (row.last_used_at === null ? 0 : 5),
        updatedAt: row.updated_at,
      };
    })
    .filter((fact) =>
      fact.topic > 0 ||
      (fact.confidence === "high" && (fact.category === "identity" || fact.category === "relationship"))
    )
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        right.updatedAt - left.updatedAt ||
        left.id - right.id,
    )
    .slice(0, safeLimit);

  if (ranked.length > 0) {
    const updates = ranked.map((fact) =>
      db
        .prepare("UPDATE memory_facts SET last_used_at = ? WHERE id = ?")
        .bind(now, fact.id),
    );
    const updateResults = await db.batch(updates);
    if (!updateResults.every((entry) => entry.success)) {
      throw new Error("memory_last_used_update_failed");
    }
  }

  return ranked.map(({ id: _id, updatedAt: _updatedAt, topic: _topic, ...fact }) => fact);
}
