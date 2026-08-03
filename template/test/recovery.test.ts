import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recoverStaleDeliveries,
  recoverStuckUpdates,
  type ScheduledDependencies,
} from "../src/scheduled";
import { handleDlqBatch } from "../src/dlq";
import { pairOwner } from "../src/storage/owner-repository";
import type { QueueJob } from "../src/queue";

const NOW = Math.floor(Date.now() / 1_000);
const OLD = NOW - 100_000;
let OWNER_ID = 1;

function capturingQueue(): {
  dependencies: ScheduledDependencies;
  sent: QueueJob[];
} {
  const sent: QueueJob[] = [];
  return {
    dependencies: {
      now: () => NOW,
      queue: { send: async (job: QueueJob) => { sent.push(job); } },
    },
    sent,
  };
}

async function clearAll(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM deliveries; DELETE FROM messages; DELETE FROM processed_updates; DELETE FROM bot_configuration; DELETE FROM conversations; DELETE FROM owners;",
  );
}

async function insertDelivery(
  kind: string,
  chunkIndex: number,
  status: string,
  attemptCount: number,
  updatedAt: number,
): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO deliveries (owner_id, kind, chunk_index, target_at, target_chat_id, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  ).bind(OWNER_ID, kind, chunkIndex, NOW, 222, status, attemptCount, NOW, updatedAt).first<{ id: number }>();
  return row?.id ?? 0;
}

beforeEach(async () => {
  await clearAll();
  await pairOwner(env.DB, 111, 222, NOW);
  OWNER_ID = (await env.DB.prepare(
    "SELECT id FROM owners ORDER BY id LIMIT 1",
  ).first<{ id: number }>())?.id ?? 1;
});

describe("recoverStaleDeliveries", () => {
  it("重推超过 10 分钟的 pending/sending/failed 气泡", async () => {
    await insertDelivery("bubble", 0, "failed", 1, OLD);
    await insertDelivery("bubble", 1, "pending", 0, OLD);
    await insertDelivery("bubble", 2, "sending", 2, OLD);
    const { dependencies, sent } = capturingQueue();
    const recovered = await recoverStaleDeliveries(env, dependencies, NOW);
    expect(recovered).toBe(3);
    expect(sent).toEqual([
      { type: "bubble", deliveryId: 1 },
      { type: "bubble", deliveryId: 2 },
      { type: "bubble", deliveryId: 3 },
    ]);
  });

  it("跳过 typing、未超时的、attempt_count 达上限的投递", async () => {
    await insertDelivery("typing", 0, "pending", 0, NOW);
    await insertDelivery("bubble", 1, "pending", 0, NOW);
    await insertDelivery("bubble", 2, "failed", 3, OLD);
    const { dependencies, sent } = capturingQueue();
    const recovered = await recoverStaleDeliveries(env, dependencies, NOW);
    expect(recovered).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("recoverStuckUpdates", () => {
  async function seedMessageAndUpdate(
    telegramUpdateId: number,
    status: string,
    lastErrorCode: string | null,
    attemptCount: number,
    updatedAt: number,
  ): Promise<number> {
    const conversation = await env.DB.prepare(
      "SELECT id FROM conversations WHERE owner_id = ? AND status = 'active' ORDER BY id LIMIT 1",
    ).bind(OWNER_ID).first<{ id: number }>();
    const conversationId = conversation?.id ?? (
      await env.DB.prepare(
        "INSERT INTO conversations (owner_id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) RETURNING id",
      ).bind(OWNER_ID, NOW, NOW).first<{ id: number }>()
    )?.id ?? 0;
    const inserted = await env.DB.prepare(
      "INSERT INTO messages (owner_id, conversation_id, role, mode, content, telegram_update_id, created_at) VALUES (?, ?, 'user', 'persona', 'hi', ?, ?) RETURNING id",
    ).bind(OWNER_ID, conversationId, telegramUpdateId, NOW).first<{ id: number }>();
    const messageId = inserted?.id ?? 0;
    await env.DB.prepare(
      "INSERT INTO processed_updates (telegram_update_id, owner_id, status, attempt_count, last_error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(telegramUpdateId, OWNER_ID, status, attemptCount, lastErrorCode, NOW, updatedAt).run();
    return messageId;
  }

  it("恢复卡死 30 分钟的 processing 更新并重新入队", async () => {
    const messageId = await seedMessageAndUpdate(-1001, "processing", null, 1, NOW - 3_000);
    const { dependencies, sent } = capturingQueue();
    const recovered = await recoverStuckUpdates(env, dependencies, NOW);
    expect(recovered).toBe(1);
    expect(sent).toEqual([
      { type: "chat", mode: "persona", ownerId: OWNER_ID, telegramUpdateId: -1001, messageId },
    ]);
    const row = await env.DB.prepare(
      "SELECT status, last_error_code FROM processed_updates WHERE telegram_update_id = ?",
    ).bind(-1001).first<{ status: string; last_error_code: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.last_error_code).toBe("stale_processing");
  });

  it("不恢复刚卡住的 processing 更新", async () => {
    await seedMessageAndUpdate(-1002, "processing", null, 1, NOW - 60);
    const { dependencies, sent } = capturingQueue();
    const recovered = await recoverStuckUpdates(env, dependencies, NOW);
    expect(recovered).toBe(0);
    expect(sent).toEqual([]);
  });

  it("重新入队暂时性失败的更新（attempt_count 未达上限）", async () => {
    const messageId = await seedMessageAndUpdate(-1003, "failed", "model_failed", 1, NOW - 3_000);
    const { dependencies, sent } = capturingQueue();
    const recovered = await recoverStuckUpdates(env, dependencies, NOW);
    expect(recovered).toBe(1);
    expect(sent).toEqual([
      { type: "chat", mode: "persona", ownerId: OWNER_ID, telegramUpdateId: -1003, messageId },
    ]);
  });

  it("不重复处理 dlq_exhausted / 非暂时性错误 / 达到上限的失败", async () => {
    await seedMessageAndUpdate(-1004, "failed", "dlq_exhausted", 1, NOW - 3_000);
    await seedMessageAndUpdate(-1005, "failed", "assistant_persist_failed", 1, NOW - 3_000);
    await seedMessageAndUpdate(-1006, "failed", "model_failed", 3, NOW - 3_000);
    const { dependencies, sent } = capturingQueue();
    const recovered = await recoverStuckUpdates(env, dependencies, NOW);
    expect(recovered).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe("handleDlqBatch", () => {
  it("把 chat 死信写回 processed_updates 并 ack", async () => {
    await env.DB.prepare(
      "INSERT INTO processed_updates (telegram_update_id, owner_id, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
    ).bind(-2001, OWNER_ID, NOW, NOW).run();
    const batch = {
      queue: "yuan-telegram-bot-dlq",
      messages: [
        {
          id: "msg-1",
          body: { type: "chat", mode: "persona", ownerId: 1, telegramUpdateId: -2001, messageId: 9 },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
    };
    await handleDlqBatch(batch as unknown as MessageBatch<unknown>, env, { fetcher: async () => new Response("{}") });
    const row = await env.DB.prepare(
      "SELECT status, last_error_code FROM processed_updates WHERE telegram_update_id = ?",
    ).bind(-2001).first<{ status: string; last_error_code: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.last_error_code).toBe("dlq_exhausted");
    expect(batch.messages[0]?.ack).toHaveBeenCalled();
  });

  it("把 bubble 死信写回 deliveries 并 ack", async () => {
    const deliveryId = await insertDelivery("bubble", 0, "sending", 3, NOW);
    const batch = {
      queue: "yuan-telegram-bot-dlq",
      messages: [
        {
          id: "msg-2",
          body: { type: "bubble", deliveryId },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
    };
    await handleDlqBatch(batch as unknown as MessageBatch<unknown>, env, { fetcher: async () => new Response("{}") });
    const row = await env.DB.prepare(
      "SELECT status, last_error_code FROM deliveries WHERE id = ?",
    ).bind(deliveryId).first<{ status: string; last_error_code: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.last_error_code).toBe("dlq_exhausted");
    expect(batch.messages[0]?.ack).toHaveBeenCalled();
  });

  it("告警按类型节流（6 小时冷却）", async () => {
    await env.DB.prepare(
      "INSERT INTO bot_configuration (key, value, updated_at) VALUES (?, ?, ?)",
    ).bind("dlq_alert_v1:chat", String(NOW), NOW).run();
    const fetcher = vi.fn(async () => new Response("{}"));
    const batch = {
      queue: "yuan-telegram-bot-dlq",
      messages: [
        {
          id: "msg-3",
          body: { type: "chat", mode: "persona", ownerId: 1, telegramUpdateId: -2002, messageId: 10 },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
    };
    await handleDlqBatch(batch as unknown as MessageBatch<unknown>, env, { fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
