export type QualityEventCategory = "retrieval" | "degradation" | "correction" | "proactive" | "evaluation" | "safety" | "error";
const FORBIDDEN_KEYS = /(?:content|prompt|message|text|body|secret|token|key)/iu;

export async function recordQualityEvent(env: Pick<Env, "DB">, input: {
  ownerId: number | null; category: QualityEventCategory; reasonCode: string;
  metrics: Record<string, number>; modelVersion: string; personaVersion: number;
  workerVersion: string; now: number;
}): Promise<void> {
  const entries = Object.entries(input.metrics);
  if (entries.length > 20 || entries.some(([key, value]) => FORBIDDEN_KEYS.test(key) || !Number.isSafeInteger(value))) {
    throw new Error("quality_event_metrics_invalid");
  }
  if (FORBIDDEN_KEYS.test(input.reasonCode) || input.reasonCode.length > 80) throw new Error("quality_event_reason_invalid");
  await env.DB.prepare(
    `INSERT INTO quality_events (owner_id, category, reason_code, metrics_json,
       model_version, persona_version, worker_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(input.ownerId, input.category, input.reasonCode, JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))),
    input.modelVersion.slice(0, 80), Math.max(0, input.personaVersion), input.workerVersion.slice(0, 80), input.now).run();
}

export async function getQualityEventStats(db: D1Database, ownerId: number, since: number) {
  const rows = await db.prepare(
    `SELECT category, reason_code, COUNT(*) AS count FROM quality_events
     WHERE owner_id = ? AND created_at >= ? GROUP BY category, reason_code ORDER BY count DESC`,
  ).bind(ownerId, since).all<{ category: QualityEventCategory; reason_code: string; count: number }>();
  return rows.results.map((row) => ({ category: row.category, reasonCode: row.reason_code, count: row.count }));
}
