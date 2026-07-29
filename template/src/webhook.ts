import { handleOwnerCommand, parseCommand } from "./commands";
import { secureEqual } from "./security";
import { cancelPersonaDraft } from "./storage/management-repository";
import {
  confirmPersonaDraft,
  seedPersona,
} from "./storage/persona-repository";
import { resolveMemoryConflict } from "./storage/semantic-memory-repository";
import {
  createRecoveryChallenge,
  createSetupChallenge,
} from "./storage/recovery-repository";
import {
  getOwner,
  pairOwner,
} from "./storage/owner-repository";
import { claimUpdate, markUpdate } from "./storage/update-repository";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "./storage/chat-repository";
import {
  createTelegramClient,
  splitTelegramText,
  type TelegramClient,
} from "./telegram";

const WEBHOOK_PATH = "/telegram/webhook";
const MAX_UPDATE_BYTES = 64 * 1_024;

export interface PrivateTextUpdate {
  updateId: number;
  messageId: number;
  userId: number;
  chatId: number;
  date: number;
  text: string;
}

interface PrivateCallbackUpdate {
  updateId: number;
  callbackQueryId: string;
  messageId: number;
  userId: number;
  chatId: number;
  data: string;
}

export interface WebhookDependencies {
  fetcher?: typeof fetch;
  queue?: { send(message: unknown): Promise<void> };
  now?: () => number;
}

interface QueueChatJob {
  type: "chat";
  mode: "persona" | "ask";
  ownerId: number;
  telegramUpdateId: number;
  messageId: number;
}

interface QueuePersonaDraftJob {
  type: "persona_draft";
  operation: "addition";
  ownerId: number;
  telegramUpdateId: number;
  messageId: number;
}

class BodyTooLargeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function parsePrivateTextUpdate(value: unknown): PrivateTextUpdate | null {
  if (!isRecord(value) || !safeInteger(value.update_id) || !isRecord(value.message)) {
    return null;
  }
  const message = value.message;
  if (
    !safeInteger(message.message_id) ||
    !safeInteger(message.date) ||
    typeof message.text !== "string" ||
    message.text.length === 0 ||
    message.text.length > 4_096 ||
    !isRecord(message.from) ||
    !safeInteger(message.from.id) ||
    message.from.is_bot === true ||
    !isRecord(message.chat) ||
    !safeInteger(message.chat.id) ||
    message.chat.type !== "private"
  ) {
    return null;
  }
  return {
    updateId: value.update_id,
    messageId: message.message_id,
    userId: message.from.id,
    chatId: message.chat.id,
    date: message.date,
    text: message.text,
  };
}

function parsePrivateCallbackUpdate(value: unknown): PrivateCallbackUpdate | null {
  if (!isRecord(value) || !safeInteger(value.update_id) || !isRecord(value.callback_query)) {
    return null;
  }
  const callback = value.callback_query;
  if (
    typeof callback.id !== "string" || callback.id.length === 0 ||
    typeof callback.data !== "string" || callback.data.length > 64 ||
    !isRecord(callback.from) || !safeInteger(callback.from.id) ||
    !isRecord(callback.message) || !safeInteger(callback.message.message_id) ||
    !isRecord(callback.message.chat) ||
    !safeInteger(callback.message.chat.id) || callback.message.chat.type !== "private"
  ) return null;
  return {
    updateId: value.update_id,
    callbackQueryId: callback.id,
    messageId: callback.message.message_id,
    userId: callback.from.id,
    chatId: callback.message.chat.id,
    data: callback.data,
  };
}

async function editCallbackStatus(
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await telegram.editMessageText(chatId, messageId, text);
  } catch {
    // The committed D1 action remains authoritative.
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_UPDATE_BYTES) {
    throw new BodyTooLargeError("telegram_update_too_large");
  }
  if (request.body === null) throw new Error("telegram_update_missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPDATE_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError("telegram_update_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function ok(): Response {
  return Response.json({ ok: true });
}

function recoveryUrl(origin: string, challengeId: string): string {
  const url = new URL("/recover", origin);
  url.searchParams.set("challenge", challengeId);
  return url.toString();
}

async function sendTexts(
  telegram: ReturnType<typeof createTelegramClient>,
  chatId: number,
  messages: string[],
): Promise<void> {
  for (const message of messages) {
    for (const chunk of splitTelegramText(message)) {
      await telegram.sendMessage(chatId, chunk);
    }
  }
}

async function markIfPresent(
  db: D1Database,
  telegramUpdateId: number,
  status: "queued" | "completed" | "failed",
  now: number,
  errorCode: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE processed_updates
       SET status = ?, updated_at = ?, last_error_code = ?
       WHERE telegram_update_id = ?`,
    )
    .bind(status, now, errorCode, telegramUpdateId)
    .run();
}

async function findMessageIdByUpdate(
  db: D1Database,
  ownerId: number,
  telegramUpdateId: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT id FROM messages
       WHERE owner_id = ? AND telegram_update_id = ?`,
    )
    .bind(ownerId, telegramUpdateId)
    .first<{ id: number }>();
  return row?.id ?? null;
}

export async function handleWebhook(
  request: Request,
  env: Env,
  dependencies: WebhookDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== WEBHOOK_PATH) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const providedSecret =
    request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await secureEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET))) {
    return new Response("Unauthorized", { status: 401 });
  }

  let rawUpdate: unknown;
  try {
    rawUpdate = await readBoundedJson(request);
  } catch (error) {
    return new Response("Invalid update", {
      status: error instanceof BodyTooLargeError ? 413 : 400,
    });
  }
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const telegram = createTelegramClient(
    env.TELEGRAM_BOT_TOKEN,
    dependencies.fetcher,
  );
  const callback = parsePrivateCallbackUpdate(rawUpdate);
  if (callback !== null) {
    const owner = await getOwner(env.DB);
    if (
      owner === null || owner.telegramUserId !== callback.userId ||
      owner.telegramChatId !== callback.chatId
    ) {
      await telegram.answerCallbackQuery(callback.callbackQueryId, "无法执行这个操作");
      return ok();
    }
    const claim = await claimUpdate(env.DB, callback.updateId, owner.ownerId, now);
    if (claim === "duplicate") {
      await telegram.answerCallbackQuery(callback.callbackQueryId, "这个操作已经处理过了");
      return ok();
    }
    const memoryConflict = callback.data.match(/^mc:(n|k):([0-9a-f-]{36})$/u);
    if (memoryConflict !== null) {
      const resolution = memoryConflict[1] === "n" ? "use_new" : "keep_old";
      const result = await resolveMemoryConflict(
        env.DB,
        owner.ownerId,
        memoryConflict[2] ?? "",
        resolution,
        now,
      );
      await telegram.answerCallbackQuery(
        callback.callbackQueryId,
        result.ok
          ? resolution === "use_new" ? "已使用新记忆" : "已保留原记忆"
          : "这个记忆冲突已经处理或过期了",
      );
      if (result.ok) {
        await editCallbackStatus(
          telegram,
          callback.chatId,
          callback.messageId,
          resolution === "use_new" ? "已使用新记忆" : "已保留原记忆",
        );
        if (result.vectorJobId !== undefined) {
          await (dependencies.queue ?? env.MESSAGE_QUEUE).send({
            type: "memory_vector_sync",
            ownerId: owner.ownerId,
          });
        }
      }
      await markIfPresent(env.DB, callback.updateId, "completed", now);
      return ok();
    }
    const match = callback.data.match(/^pd:(c|r|x):([0-9a-f-]{36})$/u);
    if (match === null) {
      await telegram.answerCallbackQuery(callback.callbackQueryId, "操作已失效");
      await markIfPresent(env.DB, callback.updateId, "completed", now);
      return ok();
    }
    const action = match[1];
    const draftId = match[2] ?? "";
    if (action === "r") {
      const source = await env.DB.prepare(
        `SELECT persona_change_drafts.operation,
                persona_change_drafts.summary,
                persona_change_drafts.impact_scope,
                persona_change_drafts.patch_json,
                persona_change_drafts.expires_at,
                persona_change_drafts.created_at,
                persona_change_drafts.source_message_id,
                messages.telegram_update_id
         FROM persona_change_drafts
         JOIN messages ON messages.id = persona_change_drafts.source_message_id
         WHERE persona_change_drafts.id = ?
           AND persona_change_drafts.owner_id = ?
           AND persona_change_drafts.expires_at >= ?`,
      ).bind(draftId, owner.ownerId, now).first<{
        operation: "correction" | "addition";
        summary: string;
        impact_scope: string;
        patch_json: string;
        expires_at: number;
        created_at: number;
        source_message_id: number;
        telegram_update_id: number;
      }>();
      if (source === null) {
        await telegram.answerCallbackQuery(callback.callbackQueryId, "这个草稿已经处理或过期了");
        await markIfPresent(env.DB, callback.updateId, "completed", now);
        return ok();
      }
      if (!(await cancelPersonaDraft(env.DB, owner.ownerId, draftId))) {
        await telegram.answerCallbackQuery(callback.callbackQueryId, "这个草稿已经处理或过期了");
        await markIfPresent(env.DB, callback.updateId, "completed", now);
        return ok();
      }
      const callbackQueue = dependencies.queue ?? env.MESSAGE_QUEUE;
      try {
        await callbackQueue.send({
          type: "persona_draft",
          operation: source.operation,
          ownerId: owner.ownerId,
          telegramUpdateId: callback.updateId,
          messageId: source.source_message_id,
          sourceTelegramUpdateId: source.telegram_update_id,
          replaceDraftId: draftId,
        });
      } catch (error) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO persona_change_drafts (
             id, owner_id, operation, summary, impact_scope, patch_json,
             expires_at, created_at, source_message_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          draftId,
          owner.ownerId,
          source.operation,
          source.summary,
          source.impact_scope,
          source.patch_json,
          source.expires_at,
          source.created_at,
          source.source_message_id,
        ).run();
        throw error;
      }
      await markIfPresent(env.DB, callback.updateId, "queued", now);
      await telegram.answerCallbackQuery(callback.callbackQueryId, "正在重新生成");
      await editCallbackStatus(
        telegram,
        callback.chatId,
        callback.messageId,
        "正在重新生成人格草稿…",
      );
      return ok();
    }
    if (action === "c") {
      const result = await confirmPersonaDraft(env.DB, owner.ownerId, draftId, now);
      await telegram.answerCallbackQuery(
        callback.callbackQueryId,
        result.ok ? "已确认并生效" : "这个草稿已经处理或过期了",
      );
      if (result.ok) {
        await editCallbackStatus(
          telegram,
          callback.chatId,
          callback.messageId,
          "人格草稿已确认并生效",
        );
      }
    } else {
      const cancelled = await cancelPersonaDraft(env.DB, owner.ownerId, draftId);
      await telegram.answerCallbackQuery(
        callback.callbackQueryId,
        cancelled ? "草稿已取消" : "这个草稿已经处理或过期了",
      );
      if (cancelled) {
        await editCallbackStatus(
          telegram,
          callback.chatId,
          callback.messageId,
          "人格草稿已取消",
        );
      }
    }
    await markIfPresent(env.DB, callback.updateId, "completed", now);
    return ok();
  }
  const update = parsePrivateTextUpdate(rawUpdate);
  if (update === null) return ok();

  const queue = dependencies.queue ?? env.MESSAGE_QUEUE;
  const owner = await getOwner(env.DB);
  const command = parseCommand(update.text);

  if (owner === null) {
    if (command?.name !== "pair" || command.argument.length === 0) return ok();
    if (!(await secureEqual(command.argument, env.OWNER_PAIRING_CODE))) return ok();

    const paired = await pairOwner(
      env.DB,
      update.userId,
      update.chatId,
      now,
    );
    if (paired === null) return ok();
    const claim = await claimUpdate(env.DB, update.updateId, paired.ownerId, now);
    if (claim === "duplicate") return ok();
    await seedPersona(env.DB, paired.ownerId, now);
    const setup = await createSetupChallenge(
      env.DB,
      update.userId,
      update.chatId,
      now,
    );
    try {
      await telegram.deleteMessage(update.chatId, update.messageId);
    } catch {
      // Pairing remains valid even when Telegram cannot remove the user's command.
    }
    await telegram.sendMessage(update.chatId, "干啥呢最近");
    if (setup.ok) {
      await telegram.sendMessage(
        update.chatId,
        `请在 10 分钟内用 HTTPS 页面设置恢复钥匙：\n${recoveryUrl(url.origin, setup.challengeId)}`,
      );
    }
    await markUpdate(env.DB, update.updateId, "completed", now);
    return ok();
  }

  const isCurrentOwner =
    owner.telegramUserId === update.userId &&
    owner.telegramChatId === update.chatId;
  if (!isCurrentOwner) {
    if (command?.name !== "recover") return ok();
    const claim = await claimUpdate(env.DB, update.updateId, owner.ownerId, now);
    if (claim === "duplicate") return ok();
    if (command.argument.length > 0) {
      try {
        await telegram.deleteMessage(update.chatId, update.messageId);
      } catch {
        // The plaintext is never copied into logs or storage.
      }
      await telegram.sendMessage(
        update.chatId,
        "不要在 Telegram 里发送恢复钥匙。请只发送 /recover，然后在 HTTPS 页面输入。",
      );
      await markIfPresent(env.DB, update.updateId, "completed", now);
      return ok();
    }
    const recovery = await createRecoveryChallenge(
      env.DB,
      update.userId,
      update.chatId,
      now,
    );
    await telegram.sendMessage(
      update.chatId,
      recovery.ok
        ? `请在 10 分钟内打开 HTTPS 恢复页面：\n${recoveryUrl(url.origin, recovery.challengeId)}`
        : "无法创建恢复链接，请稍后重试。",
    );
    await markIfPresent(env.DB, update.updateId, "completed", now);
    return ok();
  }

  const claim = await claimUpdate(env.DB, update.updateId, owner.ownerId, now);
  if (claim === "duplicate") return ok();

  if (command?.name === "settings") {
    await telegram.sendMessage(update.chatId, "打开 Persona Bot 管理面板", {
      replyMarkup: {
        inline_keyboard: [[
          { text: "打开管理面板", web_app: { url: new URL("/app", url.origin).toString() } },
        ]],
      },
    });
    await markIfPresent(env.DB, update.updateId, "completed", now);
    return ok();
  }

  if (command?.name === "recover" && command.argument.length > 0) {
    try {
      await telegram.deleteMessage(update.chatId, update.messageId);
    } catch {
      // The plaintext is never copied into logs or storage.
    }
    await telegram.sendMessage(
      update.chatId,
      "不要在 Telegram 里发送恢复钥匙。请用 /recovery-key 创建 HTTPS 页面。",
    );
    await markIfPresent(env.DB, update.updateId, "completed", now);
    return ok();
  }

  const commandResult = await handleOwnerCommand({
    db: env.DB,
    owner,
    text: update.text,
    now,
    recoveryBaseUrl: url.origin,
    reminderWorkflow: env.REMINDER_WORKFLOW,
  });
  if (commandResult.handled && commandResult.enqueue === undefined) {
    await sendTexts(telegram, update.chatId, commandResult.messages);
    await markIfPresent(env.DB, update.updateId, "completed", now);
    return ok();
  }

  const requestedMode = commandResult.enqueue?.mode ?? "persona";
  const storageMode =
    requestedMode === "persona_addition" ? "system" : requestedMode;
  const content = commandResult.enqueue?.content ?? update.text;
  let messageId =
    claim === "requeue"
      ? await findMessageIdByUpdate(env.DB, owner.ownerId, update.updateId)
      : null;
  if (messageId === null) {
    const conversation = await getOrCreateActiveConversation(
      env.DB,
      owner.ownerId,
      now,
    );
    const message = await appendMessage(env.DB, {
      ownerId: owner.ownerId,
      conversationId: conversation.conversationId,
      role: "user",
      mode: storageMode,
      content,
      telegramMessageId: update.messageId,
      telegramUpdateId: update.updateId,
      createdAt: now,
    });
    messageId = message.messageId;
  }

  const job: QueueChatJob | QueuePersonaDraftJob =
    requestedMode === "persona_addition"
      ? {
          type: "persona_draft",
          operation: "addition",
          ownerId: owner.ownerId,
          telegramUpdateId: update.updateId,
          messageId,
        }
      : {
          type: "chat",
          mode: requestedMode,
          ownerId: owner.ownerId,
          telegramUpdateId: update.updateId,
          messageId,
        };
  try {
    await queue.send(job);
    await markIfPresent(env.DB, update.updateId, "queued", now);
  } catch {
    await markIfPresent(env.DB, update.updateId, "failed", now, "queue_send_failed");
    return new Response("Temporary failure", { status: 500 });
  }
  return ok();
}
