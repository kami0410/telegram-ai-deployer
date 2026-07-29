export interface DailyUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
}

interface UsageRow {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
}

export async function reserveDailyRequest(
  db: D1Database,
  ownerId: number,
  usageDate: string,
  maximumRequests: number,
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDate) || maximumRequests < 1) {
    throw new Error("daily_usage_input_invalid");
  }
  const row = await db
    .prepare(
      `INSERT INTO usage_daily (
         owner_id, usage_date, request_count, input_tokens, output_tokens
       ) VALUES (?, ?, 1, 0, 0)
       ON CONFLICT(owner_id, usage_date) DO UPDATE SET
         request_count = request_count + 1
       WHERE request_count < ?
       RETURNING request_count, input_tokens, output_tokens`,
    )
    .bind(ownerId, usageDate, maximumRequests)
    .first<UsageRow>();
  return row !== null;
}

export async function addDailyTokenUsage(
  db: D1Database,
  ownerId: number,
  usageDate: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new Error("daily_token_usage_invalid");
  }
  const result = await db
    .prepare(
      `UPDATE usage_daily
       SET input_tokens = input_tokens + ?,
           output_tokens = output_tokens + ?
       WHERE owner_id = ? AND usage_date = ?`,
    )
    .bind(inputTokens, outputTokens, ownerId, usageDate)
    .run();
  if (result.meta.changes !== 1) throw new Error("daily_usage_not_reserved");
}

export async function getDailyUsage(
  db: D1Database,
  ownerId: number,
  usageDate: string,
): Promise<DailyUsage> {
  const row = await db
    .prepare(
      `SELECT request_count, input_tokens, output_tokens
       FROM usage_daily
       WHERE owner_id = ? AND usage_date = ?`,
    )
    .bind(ownerId, usageDate)
    .first<UsageRow>();
  return row === null
    ? { requestCount: 0, inputTokens: 0, outputTokens: 0 }
    : {
        requestCount: row.request_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      };
}
