import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramClient,
  splitTelegramText,
  TelegramError,
} from "../src/telegram";

const completeMessage = {
  ok: true,
  result: {
    message_id: 321,
    from: { id: 999, is_bot: true, first_name: "Persona Bot" },
    chat: { id: 101, type: "private" },
    date: 1_700_000_000,
    text: "嗯嗯嗯",
  },
};

afterEach(() => vi.restoreAllMocks());

describe("Telegram text splitting", () => {
  it("preserves content while respecting the limit", () => {
    const text = `${"你".repeat(3998)}\n${"好".repeat(20)}`;
    const chunks = splitTelegramText(text, 4000);

    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("Telegram API client", () => {
  it("sends inline and Web App buttons without embedding persona content", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completeMessage));
    const client = createTelegramClient("123456:test-token", fetcher);
    await client.sendMessage(101, "请选择操作", {
      replyMarkup: {
        inline_keyboard: [[
          { text: "确认新增", callback_data: "pd:c:opaque-id" },
          { text: "修改", web_app: { url: "https://persona.example/app#draft=opaque-id" } },
        ]],
      },
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.reply_markup.inline_keyboard).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("expression.rules");
  });

  it("sends a plain text message and returns its id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(completeMessage),
    );
    const client = createTelegramClient("123456:test-token", fetcher);

    await expect(client.sendMessage(101, "嗯嗯嗯")).resolves.toEqual({
      messageId: 321,
    });
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://api.telegram.org/bot123456:test-token/sendMessage",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      chat_id: 101,
      text: "嗯嗯嗯",
    });
  });

  it("sends typing and deletes a message", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: true }));
    const client = createTelegramClient("123456:test-token", fetcher);

    await expect(client.sendTyping(101)).resolves.toBeUndefined();
    await expect(client.deleteMessage(101, 222)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("edits a callback message into a terminal status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ ok: true, result: true }),
    );
    const client = createTelegramClient("123456:test-token", fetcher);

    await expect(
      client.editMessageText(201, 88, "人格草稿已确认并生效"),
    ).resolves.toBeUndefined();
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toBe(
      "https://api.telegram.org/bot123456:test-token/editMessageText",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      chat_id: 201,
      message_id: 88,
      text: "人格草稿已确认并生效",
    });
  });

  it("configures callback updates and the global Mini App menu", async () => {
    const methods: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      methods.push(new URL(String(input)).pathname.split("/").at(-1) ?? "");
      return Response.json({ ok: true, result: true });
    });
    const client = createTelegramClient("123456:test-token", fetcher);
    await client.configureManagement({
      webhookUrl: "https://persona.example/telegram/webhook",
      webhookSecret: "secret",
      appUrl: "https://persona.example/app",
    });
    expect(methods).toEqual(["setWebhook", "setChatMenuButton"]);
    const webhookBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(webhookBody.allowed_updates).toEqual(["message", "callback_query"]);
    const menuBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(menuBody.menu_button.web_app.url).toBe("https://persona.example/app");
  });

  it("classifies Telegram rate limits without leaking response text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: "private upstream description",
          parameters: { retry_after: 7 },
        },
        { status: 429 },
      ),
    );
    const client = createTelegramClient("123456:test-token", fetcher);

    const error = await client.sendMessage(101, "hello").catch((cause) => cause);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({
      code: "http_429",
      retryable: true,
      retryAfterSeconds: 7,
    });
    expect(String(error)).not.toContain("private upstream");
    expect(String(error)).not.toContain("test-token");
  });

  it("prefers the Telegram error code when HTTP status is 200", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 5 },
      }),
    );
    const client = createTelegramClient("123456:test-token", fetcher);

    const error = await client.sendMessage(101, "hello").catch((cause) => cause);
    expect(error).toMatchObject({
      code: "http_429",
      retryable: true,
      retryAfterSeconds: 5,
    });
  });

  it.each([
    [401, false],
    [403, false],
    [500, true],
  ])("classifies HTTP %s retryability", async (status, retryable) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { ok: false, error_code: status, description: "not logged" },
        { status },
      ),
    );
    const client = createTelegramClient("123456:test-token", fetcher);

    const error = await client.sendMessage(101, "hello").catch((cause) => cause);
    expect(error).toMatchObject({ code: `http_${status}`, retryable });
  });

  it("classifies network failures as retryable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket"));
    const client = createTelegramClient("123456:test-token", fetcher);

    const error = await client.sendMessage(101, "hello").catch((cause) => cause);
    expect(error).toMatchObject({ code: "network", retryable: true });
  });
});
