import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashRecoveryKey } from "../src/recovery-key";
import { handleRecoveryHttp } from "../src/recovery";
import {
  processQueueMessage,
  type QueueDependencies,
  type QueueJob,
} from "../src/queue";
import { getOwner } from "../src/storage/owner-repository";
import { setupRecoveryKey } from "../src/storage/recovery-repository";
import { handleWebhook, type WebhookDependencies } from "../src/webhook";

const NOW = 1_750_000_000;
const SECRET = "test-only-webhook-secret";

beforeEach(async () => {
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
});

function update(
  updateId: number,
  userId: number,
  chatId: number,
  text: string,
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: NOW,
      from: { id: userId, is_bot: false },
      chat: { id: chatId, type: "private" },
      text,
    },
  };
}

function webhookRequest(payload: unknown): Request {
  return new Request("https://yuan.example/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": SECRET,
    },
    body: JSON.stringify(payload),
  });
}

it("runs pairing, one durable reply, duplicate suppression, and account recovery end to end", async () => {
  const telegramTexts: string[] = [];
  const queueJobs: QueueJob[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.deepseek.com") {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "怎么了呀。你慢慢说，我先听着。你会焦虑很正常，而且你最后肯定还是会做完的。",
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    const body: unknown = JSON.parse(String(init?.body));
    if (
      url.pathname.endsWith("sendMessage") &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      "text" in body &&
      typeof body.text === "string"
    ) {
      telegramTexts.push(body.text);
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 777 } }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const webhookDependencies: WebhookDependencies = {
    fetcher,
    queue: { send: async (job) => void queueJobs.push(job as QueueJob) },
    now: () => NOW,
  };
  const queueDependencies: QueueDependencies = {
    fetcher,
    queue: { send: async (job) => void queueJobs.push(job) },
    now: () => NOW + 10,
    random: { nextUint32: () => 0xffff_ffff },
    busyProbabilityPercent: 0,
    dailyMessageLimit: 200,
  };

  await handleWebhook(
    webhookRequest(update(1, 101, 201, "/pair test-only-pairing-code")),
    env,
    webhookDependencies,
  );
  expect(telegramTexts[0]).toBe("干啥呢最近");
  const setup = await env.DB
    .prepare(
      `SELECT id FROM recovery_challenges
       WHERE purpose = 'setup' AND consumed_at IS NULL LIMIT 1`,
    )
    .first<{ id: string }>();
  expect(setup).not.toBeNull();
  if (setup === null) return;
  const oldKey = "YR-0123-4567-89AB-CDEF";
  const oldHash = await hashRecoveryKey(oldKey);
  expect(oldHash).not.toBeNull();
  if (oldHash === null) return;
  expect(
    (
      await setupRecoveryKey(env.DB, {
        challengeId: setup.id,
        newKeyHash: oldHash,
        now: NOW + 1,
      })
    ).ok,
  ).toBe(true);

  await handleWebhook(
    webhookRequest(update(2, 101, 201, "我最近好焦虑好难受")),
    env,
    webhookDependencies,
  );
  await handleWebhook(
    webhookRequest(update(2, 101, 201, "我最近好焦虑好难受")),
    env,
    webhookDependencies,
  );
  const chatJobs = queueJobs.filter(
    (job): job is Extract<QueueJob, { type: "chat" }> => job.type === "chat",
  );
  expect(chatJobs).toHaveLength(1);
  await processQueueMessage(chatJobs[0]!, env, queueDependencies);
  const bubbles = queueJobs.filter(
    (job): job is Extract<QueueJob, { type: "bubble" }> => job.type === "bubble",
  );
  for (const bubble of bubbles) {
    await processQueueMessage(bubble, env, queueDependencies);
  }
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first(),
  ).toEqual({ count: 2 });
  expect(telegramTexts.join("\n")).toContain("怎么了呀");

  await handleWebhook(
    webhookRequest(update(3, 501, 601, "/recover")),
    env,
    webhookDependencies,
  );
  const recoveryLink = telegramTexts.findLast((text) =>
    text.includes("/recover?challenge="),
  );
  expect(recoveryLink).toBeDefined();
  if (recoveryLink === undefined) return;
  const challenge = new URL(recoveryLink.split("\n").at(-1)!).searchParams.get(
    "challenge",
  );
  expect(challenge).not.toBeNull();
  if (challenge === null) return;
  const newHash = await hashRecoveryKey("YR-FEDC-BA98-7654-3210");
  expect(newHash).not.toBeNull();
  if (newHash === null) return;
  const recovered = await handleRecoveryHttp(
    new Request("https://yuan.example/api/recovery/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge, oldKey, newKeyHash: newHash }),
    }),
    env.DB,
    NOW + 20,
  );
  expect(recovered.status).toBe(200);
  expect(await getOwner(env.DB)).toMatchObject({
    telegramUserId: 501,
    telegramChatId: 601,
  });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first(),
  ).toEqual({ count: 2 });

  const queuedBeforeOldAccount = queueJobs.length;
  await handleWebhook(
    webhookRequest(update(4, 101, 201, "旧账号不应再访问")),
    env,
    webhookDependencies,
  );
  expect(queueJobs).toHaveLength(queuedBeforeOldAccount);
});
