import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashRecoveryKey } from "../src/recovery-key";
import { setupRecoveryKey } from "../src/storage/recovery-repository";
import { getOwner } from "../src/storage/owner-repository";
import {
  handleWebhook,
  parsePrivateTextUpdate,
  type WebhookDependencies,
} from "../src/webhook";

const NOW = 1_750_000_000;
const SECRET = "test-only-webhook-secret";

async function clearAll(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM owner_recovery_events;
    DELETE FROM recovery_rate_limits;
    DELETE FROM recovery_challenges;
    DELETE FROM owner_recovery;
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM pending_confirmations;
    DELETE FROM deliveries;
    DELETE FROM usage_daily;
    DELETE FROM processed_updates;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
}

function update(
  text: string,
  overrides: {
    updateId?: number;
    userId?: number;
    chatId?: number;
    messageId?: number;
    chatType?: string;
  } = {},
): unknown {
  return {
    update_id: overrides.updateId ?? 9001,
    message: {
      message_id: overrides.messageId ?? 77,
      date: NOW,
      from: { id: overrides.userId ?? 101, is_bot: false },
      chat: {
        id: overrides.chatId ?? 201,
        type: overrides.chatType ?? "private",
      },
      text,
    },
  };
}

function request(body: string, secret = SECRET): Request {
  return new Request("https://yuan.example/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body,
  });
}

function dependencies(): {
  value: WebhookDependencies;
  telegramCalls: Array<{ method: string; body: Record<string, unknown> }>;
  queueJobs: unknown[];
} {
  const telegramCalls: Array<{
    method: string;
    body: Record<string, unknown>;
  }> = [];
  const queueJobs: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const parsed: unknown = JSON.parse(String(init?.body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid_test_telegram_body");
    }
    telegramCalls.push({
      method: url.pathname.split("/").at(-1) ?? "",
      body: Object.fromEntries(Object.entries(parsed)),
    });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 999 } }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return {
    value: {
      fetcher,
      queue: { send: async (job: unknown) => void queueJobs.push(job) },
      now: () => NOW,
    },
    telegramCalls,
    queueJobs,
  };
}

beforeEach(clearAll);

describe("Telegram webhook boundary", () => {
  it("checks method, path, and secret before parsing JSON", async () => {
    const deps = dependencies();
    const wrongSecret = await handleWebhook(
      request("definitely-not-json", "wrong-secret"),
      env,
      deps.value,
    );
    expect(wrongSecret.status).toBe(401);
    expect(deps.telegramCalls).toHaveLength(0);

    const wrongMethod = await handleWebhook(
      new Request("https://yuan.example/telegram/webhook", {
        method: "GET",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
      }),
      env,
      deps.value,
    );
    expect(wrongMethod.status).toBe(405);

    const wrongPath = await handleWebhook(
      new Request("https://yuan.example/not-webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: "{}",
      }),
      env,
      deps.value,
    );
    expect(wrongPath.status).toBe(404);
  });

  it("rejects malformed or oversized bodies without echoing them", async () => {
    const deps = dependencies();
    expect((await handleWebhook(request("not-json"), env, deps.value)).status).toBe(400);
    expect(
      (
        await handleWebhook(
          request(JSON.stringify({ padding: "x".repeat(65_537) })),
          env,
          deps.value,
        )
      ).status,
    ).toBe(413);
  });

  it("ignores groups, non-text messages, edited messages, and channels", () => {
    expect(parsePrivateTextUpdate(update("hello", { chatType: "group" }))).toBeNull();
    expect(
      parsePrivateTextUpdate({
        update_id: 1,
        message: {
          message_id: 2,
          date: NOW,
          from: { id: 3 },
          chat: { id: 4, type: "private" },
          photo: [{ file_id: "x" }],
        },
      }),
    ).toBeNull();
    expect(
      parsePrivateTextUpdate({ update_id: 1, edited_message: update("x") }),
    ).toBeNull();
    expect(
      parsePrivateTextUpdate({ update_id: 1, channel_post: update("x") }),
    ).toBeNull();
  });
});

describe("single-owner pairing and recovery", () => {
  it("pairs once, deletes the code message, and sends the exact first phrase before setup", async () => {
    const deps = dependencies();
    const response = await handleWebhook(
      request(JSON.stringify(update("/pair test-only-pairing-code"))),
      env,
      deps.value,
    );

    expect(response.status).toBe(200);
    expect(await getOwner(env.DB)).toMatchObject({
      telegramUserId: 101,
      telegramChatId: 201,
    });
    const sendCalls = deps.telegramCalls.filter((call) => call.method === "sendMessage");
    expect(sendCalls[0]?.body.text).toBe("干啥呢最近");
    expect(sendCalls[1]?.body.text).toContain(
      "https://yuan.example/recover?challenge=",
    );
    expect(deps.telegramCalls.some((call) => call.method === "deleteMessage")).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_profiles").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB
        .prepare(
          "SELECT purpose, expires_at FROM recovery_challenges WHERE purpose = 'setup'",
        )
        .first(),
    ).toEqual({ purpose: "setup", expires_at: NOW + 600 });

    const secondDeps = dependencies();
    await handleWebhook(
      request(
        JSON.stringify(
          update("/pair test-only-pairing-code", {
            updateId: 9002,
            userId: 102,
            chatId: 202,
          }),
        ),
      ),
      env,
      secondDeps.value,
    );
    expect(await getOwner(env.DB)).toMatchObject({ telegramUserId: 101 });
    expect(secondDeps.telegramCalls).toHaveLength(0);
  });

  it("lets a new private account request recovery but never accepts plaintext keys", async () => {
    const pairing = dependencies();
    await handleWebhook(
      request(JSON.stringify(update("/pair test-only-pairing-code"))),
      env,
      pairing.value,
    );
    const setup = await env.DB
      .prepare(
        `SELECT id FROM recovery_challenges
         WHERE purpose = 'setup' AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .first<{ id: string }>();
    expect(setup).not.toBeNull();
    if (setup === null) return;
    const keyHash = await hashRecoveryKey("YR-0123-4567-89AB-CDEF");
    expect(keyHash).not.toBeNull();
    if (keyHash === null) return;
    expect(
      (
        await setupRecoveryKey(env.DB, {
          challengeId: setup.id,
          newKeyHash: keyHash,
          now: NOW + 1,
        })
      ).ok,
    ).toBe(true);

    const recovery = dependencies();
    await handleWebhook(
      request(
        JSON.stringify(
          update("/recover", {
            updateId: 9002,
            userId: 501,
            chatId: 601,
          }),
        ),
      ),
      env,
      recovery.value,
    );
    expect(
      recovery.telegramCalls.find((call) => call.method === "sendMessage")?.body.text,
    ).toContain("https://yuan.example/recover?challenge=");

    const plaintext = dependencies();
    await handleWebhook(
      request(
        JSON.stringify(
          update("/recover YR-0123-4567-89AB-CDEF", {
            updateId: 9003,
            userId: 501,
            chatId: 601,
            messageId: 78,
          }),
        ),
      ),
      env,
      plaintext.value,
    );
    expect(plaintext.telegramCalls.some((call) => call.method === "deleteMessage")).toBe(
      true,
    );
    expect(
      plaintext.telegramCalls.find((call) => call.method === "sendMessage")?.body.text,
    ).toContain("HTTPS");
  });

  it("queues owner text once and ignores unauthorized text", async () => {
    const pairing = dependencies();
    await handleWebhook(
      request(JSON.stringify(update("/pair test-only-pairing-code"))),
      env,
      pairing.value,
    );

    const owner = dependencies();
    const ownerRequest = request(
      JSON.stringify(update("我今天有点累", { updateId: 9010 })),
    );
    await handleWebhook(ownerRequest, env, owner.value);
    await handleWebhook(
      request(JSON.stringify(update("我今天有点累", { updateId: 9010 }))),
      env,
      owner.value,
    );
    expect(owner.queueJobs).toHaveLength(1);
    expect(owner.queueJobs[0]).toMatchObject({ type: "chat", mode: "persona" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first(),
    ).toEqual({ count: 1 });

    const stranger = dependencies();
    await handleWebhook(
      request(
        JSON.stringify(
          update("hello", { updateId: 9011, userId: 999, chatId: 998 }),
        ),
      ),
      env,
      stranger.value,
    );
    expect(stranger.queueJobs).toHaveLength(0);
    expect(stranger.telegramCalls).toHaveLength(0);
  });
});
