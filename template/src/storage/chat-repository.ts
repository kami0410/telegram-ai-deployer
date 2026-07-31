export interface ConversationRecord {
  conversationId: number;
  ownerId: number;
  status: "active" | "closed";
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  messageId: number;
  ownerId: number;
  conversationId: number;
  role: "user" | "assistant";
  mode: "persona" | "ask" | "system";
  content: string;
  telegramMessageId: number | null;
  telegramUpdateId: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: number;
}

export interface AppendMessageInput {
  ownerId: number;
  conversationId: number;
  role: "user" | "assistant";
  mode: "persona" | "ask" | "system";
  content: string;
  telegramMessageId?: number;
  telegramUpdateId?: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: number;
}

export interface ConversationSummaryRecord {
  summaryId: number;
  conversationId: number;
  fromMessageId: number;
  throughMessageId: number;
  summary: string;
  createdAt: number;
}

interface ConversationRow {
  id: number;
  owner_id: number;
  status: "active" | "closed";
  message_count: number;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  owner_id: number;
  conversation_id: number;
  role: "user" | "assistant";
  mode: "persona" | "ask" | "system";
  content: string;
  telegram_message_id: number | null;
  telegram_update_id: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: number;
}

interface SummaryRow {
  id: number;
  conversation_id: number;
  from_message_id: number;
  through_message_id: number;
  summary: string;
  created_at: number;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.id,
    ownerId: row.owner_id,
    status: row.status,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    messageId: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    role: row.role,
    mode: row.mode,
    content: row.content,
    telegramMessageId: row.telegram_message_id,
    telegramUpdateId: row.telegram_update_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at,
  };
}

function toSummary(row: SummaryRow): ConversationSummaryRecord {
  return {
    summaryId: row.id,
    conversationId: row.conversation_id,
    fromMessageId: row.from_message_id,
    throughMessageId: row.through_message_id,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

export async function getOrCreateActiveConversation(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<ConversationRecord> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO conversations (
         owner_id, status, message_count, created_at, updated_at
       ) VALUES (?, 'active', 0, ?, ?)`,
    )
    .bind(ownerId, now, now)
    .run();
  const row = await db
    .prepare(
      `SELECT id, owner_id, status, message_count, created_at, updated_at
       FROM conversations
       WHERE owner_id = ? AND status = 'active'`,
    )
    .bind(ownerId)
    .first<ConversationRow>();
  if (row === null) throw new Error("active_conversation_missing");
  return toConversation(row);
}

export async function appendMessage(
  db: D1Database,
  input: AppendMessageInput,
): Promise<StoredMessage> {
  if (input.content.length === 0 || input.content.length > 100_000) {
    throw new Error("message_content_invalid");
  }
  const row = await db
    .prepare(
      `INSERT INTO messages (
         owner_id, conversation_id, role, mode, content,
         telegram_message_id, telegram_update_id,
         input_tokens, output_tokens, created_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM conversations
         WHERE id = ? AND owner_id = ? AND status = 'active'
       )
       RETURNING id, owner_id, conversation_id, role, mode, content,
                 telegram_message_id, telegram_update_id,
                 input_tokens, output_tokens, created_at`,
    )
    .bind(
      input.ownerId,
      input.conversationId,
      input.role,
      input.mode,
      input.content,
      input.telegramMessageId ?? null,
      input.telegramUpdateId ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.createdAt,
      input.conversationId,
      input.ownerId,
    )
    .first<MessageRow>();
  if (row === null) throw new Error("active_conversation_not_found");

  const updated = await db
    .prepare(
      `UPDATE conversations
       SET message_count = message_count + 1, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'active'`,
    )
    .bind(input.createdAt, input.conversationId, input.ownerId)
    .run();
  if (updated.meta.changes !== 1) throw new Error("conversation_update_failed");
  return toMessage(row);
}

export async function getRecentMessages(
  db: D1Database,
  conversationId: number,
  limit: number,
): Promise<StoredMessage[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = await db
    .prepare(
      `SELECT id, owner_id, conversation_id, role, mode, content,
              telegram_message_id, telegram_update_id,
              input_tokens, output_tokens, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(conversationId, safeLimit)
    .all<MessageRow>();
  return result.results.reverse().map(toMessage);
}

export async function saveConversationSummary(
  db: D1Database,
  input: {
    conversationId: number;
    fromMessageId: number;
    throughMessageId: number;
    summary: string;
    createdAt: number;
  },
): Promise<ConversationSummaryRecord> {
  if (
    input.summary.length === 0 ||
    input.summary.length > 8_000 ||
    input.fromMessageId > input.throughMessageId
  ) {
    throw new Error("conversation_summary_invalid");
  }
  const sourceCount = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE conversation_id = ? AND id IN (?, ?)`,
    )
    .bind(input.conversationId, input.fromMessageId, input.throughMessageId)
    .first<{ count: number }>();
  const expected = input.fromMessageId === input.throughMessageId ? 1 : 2;
  if (sourceCount?.count !== expected) {
    throw new Error("conversation_summary_source_not_found");
  }

  const row = await db
    .prepare(
      `INSERT INTO conversation_summaries (
         conversation_id, from_message_id, through_message_id, summary, created_at
       ) VALUES (?, ?, ?, ?, ?)
       RETURNING id, conversation_id, from_message_id, through_message_id,
                 summary, created_at`,
    )
    .bind(
      input.conversationId,
      input.fromMessageId,
      input.throughMessageId,
      input.summary,
      input.createdAt,
    )
    .first<SummaryRow>();
  if (row === null) throw new Error("conversation_summary_insert_failed");
  return toSummary(row);
}

export async function getLatestConversationSummary(
  db: D1Database,
  conversationId: number,
): Promise<ConversationSummaryRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, conversation_id, from_message_id, through_message_id,
              summary, created_at
       FROM conversation_summaries
       WHERE conversation_id = ?
       ORDER BY through_message_id DESC, id DESC
       LIMIT 1`,
    )
    .bind(conversationId)
    .first<SummaryRow>();
  return row === null ? null : toSummary(row);
}

export async function countUnsummarizedMessages(
  db: D1Database,
  conversationId: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ?
         AND mode = 'persona'
         AND id > COALESCE((
           SELECT MAX(through_message_id)
           FROM conversation_summaries
           WHERE conversation_id = ?
         ), 0)`,
    )
    .bind(conversationId, conversationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function closeActiveConversation(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE conversations
       SET status = 'closed', closed_at = ?, updated_at = ?
       WHERE owner_id = ? AND status = 'active'`,
    )
    .bind(now, now, ownerId)
    .run();
  return result.meta.changes === 1;
}
