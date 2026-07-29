const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_RESPONSE_BYTES = 64 * 1024;

interface TelegramEnvelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`telegram:${code}`);
    this.name = "TelegramError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > MAX_RESPONSE_BYTES) {
    throw new TelegramError("response_too_large", false);
  }

  if (response.body === null) {
    throw new TelegramError("empty_response", response.status >= 500);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TelegramError("response_too_large", false);
    }
    chunks.push(part.value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TelegramError("invalid_json", response.status >= 500);
  }
}

function asEnvelope(value: unknown): TelegramEnvelope | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;

  const envelope: TelegramEnvelope = { ok: value.ok };
  if ("result" in value) envelope.result = value.result;
  if (typeof value.error_code === "number") {
    envelope.error_code = value.error_code;
  }
  if (isRecord(value.parameters) && typeof value.parameters.retry_after === "number") {
    envelope.parameters = { retry_after: value.parameters.retry_after };
  }
  return envelope;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface TelegramClient {
  sendMessage(
    chatId: number,
    text: string,
    options?: { replyMarkup?: TelegramReplyMarkup },
  ): Promise<{ messageId: number }>;
  sendTyping(chatId: number): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  configureManagement(input: {
    webhookUrl: string;
    webhookSecret: string;
    appUrl: string;
  }): Promise<void>;
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export function createTelegramClient(
  token: string,
  fetcher: typeof fetch = fetch,
): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TelegramError("network", true);
    }

    const envelope = asEnvelope(await readBoundedJson(response));
    if (envelope === null) {
      throw new TelegramError("invalid_response", retryableStatus(response.status));
    }

    if (!response.ok || !envelope.ok) {
      const status = response.ok
        ? (envelope.error_code ?? response.status)
        : response.status;
      const retryAfter = envelope.parameters?.retry_after ?? null;
      throw new TelegramError(
        `http_${status}`,
        retryableStatus(status),
        retryAfter,
      );
    }

    return envelope.result;
  }

  return {
    async sendMessage(chatId, text, options) {
      const result = await call("sendMessage", {
        chat_id: chatId,
        text,
        ...(options?.replyMarkup === undefined
          ? {}
          : { reply_markup: options.replyMarkup }),
      });
      if (!isRecord(result) || typeof result.message_id !== "number") {
        throw new TelegramError("missing_message_id", false);
      }
      return { messageId: result.message_id };
    },

    async sendTyping(chatId) {
      await call("sendChatAction", { chat_id: chatId, action: "typing" });
    },

    async deleteMessage(chatId, messageId) {
      await call("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
    },

    async editMessageText(chatId, messageId, text) {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
      });
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text === undefined ? {} : { text }),
      });
    },

    async configureManagement(input) {
      const webhookUrl = new URL(input.webhookUrl);
      const appUrl = new URL(input.appUrl);
      if (
        webhookUrl.protocol !== "https:" || appUrl.protocol !== "https:" ||
        input.webhookSecret.length === 0
      ) throw new TelegramError("management_config_invalid", false);
      await call("setWebhook", {
        url: webhookUrl.toString(),
        secret_token: input.webhookSecret,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
      await call("setChatMenuButton", {
        menu_button: {
          type: "web_app",
          text: "Persona Bot 管理",
          web_app: { url: appUrl.toString() },
        },
      });
    },
  };
}

export function splitTelegramText(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const newline = window.lastIndexOf("\n", limit);
    const space = window.lastIndexOf(" ", limit);
    const preferred = Math.max(newline, space);
    const cutoff = preferred >= Math.floor(limit / 2) ? preferred + 1 : limit;
    chunks.push(remaining.slice(0, cutoff));
    remaining = remaining.slice(cutoff);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
