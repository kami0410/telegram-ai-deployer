import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processQueueMessage,
  type QueueDependencies,
  type QueueJob,
} from "../src/queue";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import { seedPersona } from "../src/storage/persona-repository";
import { claimUpdate, markUpdate } from "../src/storage/update-repository";
import { setBusyUntil } from "../src/storage/runtime-repository";
import { saveMemoryExtraction } from "../src/storage/semantic-memory-repository";
import { reserveDailyRequest } from "../src/storage/usage-repository";

const NOW = 1_750_000_000;

async function clearAll(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM deliveries;
    DELETE FROM usage_daily;
    DELETE FROM processed_updates;
    DELETE FROM memory_update_failures;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
}

async function chatJob(
  updateId = 9001,
  content = "我今天还不错",
): Promise<Extract<QueueJob, { type: "chat" }>> {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  const existingOwner = owner ??
    (await env.DB
      .prepare(
        `SELECT id AS ownerId, telegram_user_id AS telegramUserId,
                telegram_chat_id AS telegramChatId, paired_at AS pairedAt,
                migrated_at AS migratedAt FROM owners LIMIT 1`,
      )
      .first<{
        ownerId: number;
        telegramUserId: number;
        telegramChatId: number;
        pairedAt: number;
        migratedAt: number | null;
      }>());
  expect(existingOwner).not.toBeNull();
  if (existingOwner === null) throw new Error("owner_fixture_failed");
  if (owner !== null) await seedPersona(env.DB, owner.ownerId, NOW + 1);
  const conversation = await getOrCreateActiveConversation(
    env.DB,
    existingOwner.ownerId,
    NOW + 2,
  );
  await claimUpdate(env.DB, updateId, existingOwner.ownerId, NOW + 3);
  const message = await appendMessage(env.DB, {
    ownerId: existingOwner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "persona",
    content,
    telegramUpdateId: updateId,
    telegramMessageId: updateId,
    createdAt: NOW + 3,
  });
  await markUpdate(env.DB, updateId, "queued", NOW + 3);
  return {
    type: "chat",
    mode: "persona",
    ownerId: existingOwner.ownerId,
    telegramUpdateId: updateId,
    messageId: message.messageId,
  };
}

function dependencies(options: {
  now?: () => number;
  telegramStatus?: number;
  deepSeekStatus?: number;
  deepSeekContent?: string;
  dailyMessageLimit?: number;
} = {}): {
  value: QueueDependencies;
  deepSeekBodies: Array<Record<string, unknown>>;
  telegramMethods: string[];
  telegramBodies: Array<Record<string, unknown>>;
  queued: Array<{ job: QueueJob; delaySeconds: number }>;
} {
  const deepSeekBodies: Array<Record<string, unknown>> = [];
  const telegramMethods: string[] = [];
  const telegramBodies: Array<Record<string, unknown>> = [];
  const queued: Array<{ job: QueueJob; delaySeconds: number }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.deepseek.com") {
      const parsed: unknown = JSON.parse(String(init?.body));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        deepSeekBodies.push(Object.fromEntries(Object.entries(parsed)));
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  options.deepSeekContent ??
                  "嗯嗯嗯听起来今天还不错呀。那就稍微放松一下。但是该做的还是要做哈哈哈哈哈哈。",
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
        }),
        {
          status: options.deepSeekStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    telegramMethods.push(url.pathname.split("/").at(-1) ?? "");
    telegramBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify(
        options.telegramStatus !== undefined && options.telegramStatus >= 400
          ? { ok: false, error_code: options.telegramStatus, description: "private" }
          : { ok: true, result: { message_id: 777 } },
      ),
      {
        status: options.telegramStatus ?? 200,
        headers: {
          "content-type": "application/json",
          ...(options.telegramStatus === 429 ? { "retry-after": "2" } : {}),
        },
      },
    );
  });
  return {
    value: {
      fetcher,
      queue: {
        send: async (job: QueueJob, sendOptions?: { delaySeconds?: number }) => {
          queued.push({ job, delaySeconds: sendOptions?.delaySeconds ?? 0 });
        },
      },
      now: options.now ?? (() => NOW + 10),
      random: { nextUint32: () => 0xffff_ffff },
      busyProbabilityPercent: 0,
      dailyMessageLimit: options.dailyMessageLimit ?? 200,
    },
    deepSeekBodies,
    telegramMethods,
    telegramBodies,
    queued,
  };
}

beforeEach(clearAll);

describe("queue chat outbox", () => {
  it("queues a memory update after sixteen unsummarized persona messages even when total count is odd", async () => {
    const job = await chatJob(8998, "test message");
    const source = await env.DB.prepare(
      "SELECT conversation_id FROM messages WHERE telegram_update_id = 8998",
    ).first<{ conversation_id: number }>();
    if (source === null) throw new Error("source_missing");
    for (let index = 0; index < 14; index += 1) {
      await appendMessage(env.DB, {
        ownerId: job.ownerId,
        conversationId: source.conversation_id,
        role: index % 2 === 0 ? "assistant" : "user",
        mode: "persona",
        content: `historical message ${index}`,
        createdAt: NOW + 4 + index,
      });
    }
    await env.DB.prepare(
      "UPDATE conversations SET message_count = 322 WHERE id = ?",
    ).bind(source.conversation_id).run();
    const deps = dependencies();

    await processQueueMessage(job, env, deps.value);

    expect(
      deps.queued.some((entry) => entry.job.type === "memory_update"),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT message_count FROM conversations WHERE id = ?",
      ).bind(source.conversation_id).first(),
    ).toEqual({ message_count: 323 });
  });

  it("records a non-retryable memory extraction failure without storing chat content", async () => {
    const job = await chatJob(8997, "failure fixture");
    const source = await env.DB.prepare(
      "SELECT conversation_id FROM messages WHERE telegram_update_id = 8997",
    ).first<{ conversation_id: number }>();
    if (source === null) throw new Error("source_missing");
    const deps = dependencies({ deepSeekStatus: 400 });

    await expect(processQueueMessage({
      type: "memory_update",
      ownerId: job.ownerId,
      conversationId: source.conversation_id,
    }, env, deps.value)).resolves.toBeUndefined();

    expect(await env.DB.prepare(
      `SELECT error_code, failure_count FROM memory_update_failures
       WHERE owner_id = ? AND conversation_id = ?`,
    ).bind(job.ownerId, source.conversation_id).first()).toEqual({
      error_code: "upstream_4xx",
      failure_count: 1,
    });
  });

  it("shows inline choices instead of overwriting a conflicting stable fact", async () => {
    const job = await chatJob(8999, "我的目标改变了");
    const source = await env.DB.prepare(
      "SELECT id, conversation_id FROM messages WHERE telegram_update_id = 8999",
    ).first<{ id: number; conversation_id: number }>();
    if (source === null) throw new Error("source_missing");
    await saveMemoryExtraction(env.DB, {
      ownerId: job.ownerId,
      conversationId: source.conversation_id,
      stableFacts: [{
        category: "goal",
        factKey: "current_goal",
        factValue: "准备期末考试",
        confidence: "high",
        sourceMessageId: source.id,
      }],
      episodes: [],
      now: NOW + 4,
    });
    const deps = dependencies({
      deepSeekContent: JSON.stringify({
        summary: "OWNER 的目标改变了。",
        through_message_id: source.id,
        stable_facts: [{
          category: "goal",
          fact_key: "current_goal",
          fact_value: "准备研究生考试",
          confidence: "high",
          source_message_id: source.id,
        }],
        episodes: [],
      }),
    });
    await reserveDailyRequest(env.DB, job.ownerId, "2025-06-15", 200);
    await processQueueMessage({
      type: "memory_update",
      ownerId: job.ownerId,
      conversationId: source.conversation_id,
    }, env, deps.value);

    const payload = JSON.stringify(deps.telegramBodies);
    expect(payload).toContain("发现一条可能冲突的长期记忆");
    expect(payload).toContain("使用新记忆");
    expect(payload).toContain("保留原记忆");
    expect(payload).toContain("手动修改");
    expect(payload).toContain('"callback_data":"mc:n:');
  });

  it("uses 100 tokens for chat while preserving 1200 for memory JSON", async () => {
    const job = await chatJob();
    const chatDeps = dependencies();
    await processQueueMessage(job, env, chatDeps.value);
    expect(chatDeps.deepSeekBodies[0]?.max_tokens).toBe(100);
    expect(JSON.stringify(chatDeps.deepSeekBodies[0]?.messages)).toContain(
      "[CURRENT_BEIJING_TIME]\\n2025-06-15 23:06:50（北京时间，UTC+8）",
    );

    const messages = await env.DB
      .prepare("SELECT id, conversation_id FROM messages ORDER BY id")
      .all<{ id: number; conversation_id: number }>();
    const latest = messages.results.at(-1);
    expect(latest).toBeDefined();
    if (latest === undefined) return;
    const memoryDeps = dependencies({
      deepSeekContent: JSON.stringify({
        summary: "OWNER 今天状态不错。",
        through_message_id: latest.id,
        stable_facts: [],
        episodes: [],
      }),
    });
    await processQueueMessage(
      {
        type: "memory_update",
        ownerId: job.ownerId,
        conversationId: latest.conversation_id,
      },
      env,
      memoryDeps.value,
    );
    expect(memoryDeps.deepSeekBodies[0]?.max_tokens).toBe(1_200);
  });

  it("calls DeepSeek once, saves the answer first, and reuses it on redelivery", async () => {
    const job = await chatJob();
    const deps = dependencies();
    const sender = deps.value.queue;
    expect(sender).toBeDefined();
    if (sender === undefined) return;
    sender.send = async (queuedJob, options) => {
      const assistant = await env.DB
        .prepare("SELECT id FROM messages WHERE role = 'assistant'")
        .first();
      expect(assistant).not.toBeNull();
      deps.queued.push({
        job: queuedJob,
        delaySeconds: options?.delaySeconds ?? 0,
      });
    };

    await processQueueMessage(job, env, deps.value);
    await processQueueMessage(job, env, deps.value);

    expect(deps.deepSeekBodies).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM deliveries").first(),
    ).toMatchObject({ count: expect.any(Number) });
    expect(deps.queued.some((entry) => entry.job.type === "typing")).toBe(true);
    expect(deps.queued.filter((entry) => entry.job.type === "bubble").length).toBeGreaterThanOrEqual(2);
    expect(
      deps.queued.filter((entry) => entry.job.type === "bubble").every(
        (entry) => entry.delaySeconds >= 6,
      ),
    ).toBe(true);
  });

  it("queues only one bubble and schedules the next after the first is sent", async () => {
    const job = await chatJob();
    const deps = dependencies();

    await processQueueMessage(job, env, deps.value);
    const initiallyQueued = deps.queued.filter(
      (entry) => entry.job.type === "bubble",
    );
    expect(initiallyQueued).toHaveLength(1);
    const first = initiallyQueued[0]?.job;
    expect(first?.type).toBe("bubble");
    if (first?.type !== "bubble") return;

    await processQueueMessage(first, env, deps.value);

    const bubblesAfterSend = deps.queued.filter(
      (entry) => entry.job.type === "bubble",
    );
    expect(bubblesAfterSend).toHaveLength(2);
    expect(bubblesAfterSend[1]?.delaySeconds).toBeGreaterThanOrEqual(2);
    expect(bubblesAfterSend[1]?.delaySeconds).toBeLessThanOrEqual(4);
  });

  it("sends each persisted bubble once and completes the Update", async () => {
    const job = await chatJob();
    const deps = dependencies();
    await processQueueMessage(job, env, deps.value);
    const processed = new Set<number>();
    while (true) {
      const bubble = deps.queued
        .map((entry) => entry.job)
        .find(
          (queuedJob): queuedJob is Extract<QueueJob, { type: "bubble" }> =>
            queuedJob.type === "bubble" && !processed.has(queuedJob.deliveryId),
        );
      if (bubble === undefined) break;
      processed.add(bubble.deliveryId);
      await processQueueMessage(bubble, env, deps.value);
      await processQueueMessage(bubble, env, deps.value);
    }

    const persisted = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE kind = 'bubble'")
      .first<{ count: number }>();
    expect(deps.telegramMethods.filter((method) => method === "sendMessage")).toHaveLength(
      persisted?.count ?? 0,
    );
    expect(
      await env.DB
        .prepare("SELECT status FROM processed_updates WHERE telegram_update_id = 9001")
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("refreshes typing and classifies Telegram 429 as retryable", async () => {
    const job = await chatJob();
    const deps = dependencies();
    await processQueueMessage(job, env, deps.value);
    const typing = deps.queued.find((entry) => entry.job.type === "typing")?.job;
    expect(typing?.type).toBe("typing");
    if (typing?.type !== "typing") return;
    await processQueueMessage(typing, env, deps.value);
    expect(deps.telegramMethods).toContain("sendChatAction");

    const failing = dependencies({ telegramStatus: 429 });
    const bubble = deps.queued.find((entry) => entry.job.type === "bubble")?.job;
    expect(bubble?.type).toBe("bubble");
    if (bubble?.type !== "bubble") return;
    await expect(processQueueMessage(bubble, env, failing.value)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("reclaims a delivery left sending by an interrupted Worker", async () => {
    const job = await chatJob();
    const deps = dependencies({ now: () => NOW + 10 });
    await processQueueMessage(job, env, deps.value);
    const bubble = deps.queued.find((entry) => entry.job.type === "bubble")?.job;
    expect(bubble?.type).toBe("bubble");
    if (bubble?.type !== "bubble") return;

    await env.DB
      .prepare(
        `UPDATE deliveries
         SET status = 'sending', updated_at = ?
         WHERE id = ?`,
      )
      .bind(NOW - 301, bubble.deliveryId)
      .run();

    await processQueueMessage(bubble, env, deps.value);

    expect(deps.telegramMethods.filter((method) => method === "sendMessage")).toHaveLength(1);
    expect(
      await env.DB
        .prepare("SELECT status FROM deliveries WHERE id = ?")
        .bind(bubble.deliveryId)
        .first(),
    ).toEqual({ status: "sent" });
  });

  it("enforces the daily limit without calling DeepSeek", async () => {
    const job = await chatJob();
    await env.DB
      .prepare(
        `INSERT INTO usage_daily (
           owner_id, usage_date, request_count, input_tokens, output_tokens
         ) VALUES (?, '2025-06-15', 1, 0, 0)`,
      )
      .bind(job.ownerId)
      .run();
    const deps = dependencies({ dailyMessageLimit: 1 });
    await processQueueMessage(job, env, deps.value);

    expect(deps.deepSeekBodies).toHaveLength(0);
    expect(
      await env.DB.prepare("SELECT content FROM messages WHERE role = 'assistant'").first(),
    ).toEqual({ content: "今天先聊到这里吧，明天再继续呀。" });
  });

  it("marks the Update failed when a retryable DeepSeek call fails", async () => {
    const job = await chatJob();
    const deps = dependencies({ deepSeekStatus: 503 });

    await expect(processQueueMessage(job, env, deps.value)).rejects.toMatchObject({
      code: "upstream_5xx",
      retryable: true,
    });
    expect(
      await env.DB
        .prepare(
          "SELECT status, last_error_code FROM processed_updates WHERE telegram_update_id = ?",
        )
        .bind(job.telegramUpdateId)
        .first(),
    ).toEqual({ status: "failed", last_error_code: "upstream_5xx" });
  });
});

describe("busy message aggregation", () => {
  it("stores inbound messages while busy and combines them into one later reply", async () => {
    const first = await chatJob(9001, "第一条消息");
    const second = await chatJob(9002, "第二条消息");
    await setBusyUntil(env.DB, first.ownerId, NOW + 3_600, NOW + 5);
    let current = NOW + 10;
    const deps = dependencies({ now: () => current });

    await processQueueMessage(first, env, deps.value);
    await processQueueMessage(second, env, deps.value);
    expect(deps.deepSeekBodies).toHaveLength(0);
    expect(deps.queued.some((entry) => entry.job.type === "busy_resume")).toBe(true);

    current = NOW + 3_601;
    await processQueueMessage(
      { type: "busy_resume", ownerId: first.ownerId },
      env,
      deps.value,
    );
    expect(deps.deepSeekBodies).toHaveLength(1);
    const requestText = JSON.stringify(deps.deepSeekBodies[0]);
    expect(requestText).toContain("第一条消息");
    expect(requestText).toContain("第二条消息");
  });
});
