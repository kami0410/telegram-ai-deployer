import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parsePrivatePhotoUpdate,
  handleWebhook,
  type WebhookDependencies,
} from "../src/webhook";
import {
  describeImage,
  fetchTelegramFileBase64,
  type VisionAi,
} from "../src/image-vision";
import { pairOwner } from "../src/storage/owner-repository";
import { claimUpdate, markUpdate } from "../src/storage/update-repository";
import { processQueueMessage, type QueueDependencies } from "../src/queue";
import type { QueueJob } from "../src/queue";

const NOW = Math.floor(Date.now() / 1_000);
let OWNER_ID = 1;

async function clearAll(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM messages; DELETE FROM processed_updates; DELETE FROM bot_configuration; DELETE FROM conversations; DELETE FROM owners;",
  );
}

async function seedOwner(): Promise<number> {
  await pairOwner(env.DB, 111, 222, NOW);
  OWNER_ID = (await env.DB.prepare("SELECT id FROM owners LIMIT 1").first<{ id: number }>())?.id ?? 1;
  return OWNER_ID;
}

function photoUpdateBody(updateId: number, caption?: string): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: 700 + updateId,
      date: NOW,
      from: { id: 111, is_bot: false },
      chat: { id: 222, type: "private" },
      photo: [
        { file_id: "small-file", file_size: 1000, width: 100, height: 100 },
        { file_id: "big-file", file_size: 50_000, width: 800, height: 600 },
      ],
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

function webhookDeps(fetcher: typeof fetch, queue?: { send: (job: unknown) => Promise<void> }): WebhookDependencies {
  return { fetcher, ...(queue === undefined ? {} : { queue: queue as never }) };
}

const fakeFileFetcher = (base64: string): typeof fetch =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/photo.jpg" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/file/bot")) {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      return new Response(bytes);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  });

beforeEach(async () => {
  await clearAll();
  await seedOwner();
});

describe("parsePrivatePhotoUpdate", () => {
  it("解析 photo 消息并选择最大的文件", () => {
    const parsed = parsePrivatePhotoUpdate(photoUpdateBody(1, "我家猫"));
    expect(parsed?.fileId).toBe("big-file");
    expect(parsed?.caption).toBe("我家猫");
    expect(parsed?.updateId).toBe(1);
  });

  it("无 caption 时返回 null caption", () => {
    const parsed = parsePrivatePhotoUpdate(photoUpdateBody(2));
    expect(parsed?.caption).toBeNull();
    expect(parsed?.fileId).toBe("big-file");
  });

  it("非 photo 消息返回 null", () => {
    expect(parsePrivatePhotoUpdate({ update_id: 3, message: { text: "hi" } })).toBeNull();
    expect(parsePrivatePhotoUpdate(null)).toBeNull();
  });
});

describe("fetchTelegramFileBase64", () => {
  it("下载文件并转 base64", async () => {
    const base64 = btoa("fake-image-bytes");
    const result = await fetchTelegramFileBase64("token", "file-id", fakeFileFetcher(base64));
    expect(result).toBe(base64);
  });

  it("getFile 失败时抛出错误", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false })));
    await expect(fetchTelegramFileBase64("token", "f", fetcher)).rejects.toThrow();
  });
});

describe("describeImage", () => {
  it("调用 Workers AI 视觉模型并返回描述", async () => {
    const ai: VisionAi = {
      run: vi.fn(async () => ({ response: "一只橘猫坐在窗台上" })),
    };
    const description = await describeImage(ai, "test-model", "base64data");
    expect(description).toBe("一只橘猫坐在窗台上");
    expect(ai.run).toHaveBeenCalledWith(
      "test-model",
      expect.objectContaining({ prompt: expect.any(String), image: "data:image/png;base64,base64data" }),
    );
  });

  it("AI 不可用或响应非法时抛错", async () => {
    await expect(describeImage(null, "m", "b64")).rejects.toThrow();
    await expect(describeImage({ run: async () => ({}) }, "m", "b64")).rejects.toThrow();
  });
});

describe("webhook 图片消息完整链路", () => {
  it("下载 → 存 KV → 入队 chat job（携带 imageKey）→ 消息落库", async () => {
    const base64 = btoa("photo-bytes");
    const sent: QueueJob[] = [];
    const queue = { send: async (job: unknown) => { sent.push(job as QueueJob); } };
    const response = await handleWebhook(
      new Request("https://yuan.example/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
        body: JSON.stringify(photoUpdateBody(901, "今天拍的")),
      }),
      env,
      webhookDeps(fakeFileFetcher(base64), queue),
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const job = sent[0] as Extract<QueueJob, { type: "chat" }>;
    expect(job.type).toBe("chat");
    expect(job.imageKey).toBe("img:901");
    expect(job.telegramUpdateId).toBe(901);
    const cached = await env.IMAGE_CACHE.get("img:901", "text");
    expect(cached).toBe(base64);
    const message = await env.DB.prepare(
      "SELECT content FROM messages WHERE telegram_update_id = ?",
    ).bind(901).first<{ content: string }>();
    expect(message?.content).toBe("今天拍的");
    const update = await env.DB.prepare(
      "SELECT status FROM processed_updates WHERE telegram_update_id = ?",
    ).bind(901).first<{ status: string }>();
    expect(update?.status).toBe("queued");
  });

  it("非当前 owner 的图片消息被忽略", async () => {
    const body = photoUpdateBody(902) as Record<string, unknown>;
    (body.message as Record<string, unknown>).from = { id: 999, is_bot: false };
    const response = await handleWebhook(
      new Request("https://yuan.example/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
        body: JSON.stringify(body),
      }),
      env,
      webhookDeps(fakeFileFetcher(btoa("x"))),
    );
    expect(response.status).toBe(200);
    expect(await env.IMAGE_CACHE.get("img:902", "text")).toBeNull();
  });

  it("重复的图片 update 被去重", async () => {
    await claimUpdate(env.DB, 903, OWNER_ID, NOW);
    await markUpdate(env.DB, 903, "completed", NOW);
    const sent: unknown[] = [];
    const response = await handleWebhook(
      new Request("https://yuan.example/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
        body: JSON.stringify(photoUpdateBody(903)),
      }),
      env,
      webhookDeps(fakeFileFetcher(btoa("x")), { send: async (job) => { sent.push(job); } }),
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

describe("processChat 图片描述注入", () => {
  it("vision 成功时把描述写回消息内容，KV 被删除", async () => {
    const conversation = await env.DB.prepare(
      "INSERT INTO conversations (owner_id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) RETURNING id",
    ).bind(OWNER_ID, NOW, NOW).first<{ id: number }>();
    const message = await env.DB.prepare(
      "INSERT INTO messages (owner_id, conversation_id, role, mode, content, telegram_update_id, created_at) VALUES (?, ?, 'user', 'persona', '今天拍的', 904, ?) RETURNING id",
    ).bind(OWNER_ID, conversation?.id ?? 0, NOW).first<{ id: number }>();
    await claimUpdate(env.DB, 904, OWNER_ID, NOW);
    await env.IMAGE_CACHE.put("img:904", "fake-base64", { expirationTtl: 900 });
    const dependencies: QueueDependencies = {
      vision: async () => "一只橘猫坐在窗台上",
    };
    const before = await env.IMAGE_CACHE.get("img:904", "text");
    expect(before).toBe("fake-base64");
    await processQueueMessage(
      { type: "chat", mode: "persona", ownerId: OWNER_ID, telegramUpdateId: 904, messageId: message?.id ?? 0, imageKey: "img:904" },
      env,
      dependencies,
    );
    const updated = await env.DB.prepare(
      "SELECT content FROM messages WHERE id = ?",
    ).bind(message?.id ?? 0).first<{ content: string }>();
    expect(updated?.content).toContain("一只橘猫坐在窗台上");
    expect(await env.IMAGE_CACHE.get("img:904", "text")).toBeNull();
  });

  it("vision 失败时回退为无法识别，且不破坏流程", async () => {
    const conversation = await env.DB.prepare(
      "INSERT INTO conversations (owner_id, status, created_at, updated_at) VALUES (?, 'active', ?, ?) RETURNING id",
    ).bind(OWNER_ID, NOW, NOW).first<{ id: number }>();
    const message = await env.DB.prepare(
      "INSERT INTO messages (owner_id, conversation_id, role, mode, content, telegram_update_id, created_at) VALUES (?, ?, 'user', 'persona', '[图片]', 905, ?) RETURNING id",
    ).bind(OWNER_ID, conversation?.id ?? 0, NOW).first<{ id: number }>();
    await claimUpdate(env.DB, 905, OWNER_ID, NOW);
    await env.IMAGE_CACHE.put("img:905", "fake-base64", { expirationTtl: 900 });
    await processQueueMessage(
      { type: "chat", mode: "persona", ownerId: OWNER_ID, telegramUpdateId: 905, messageId: message?.id ?? 0, imageKey: "img:905" },
      env,
      { vision: async () => { throw new Error("vision_down"); } },
    );
    const updated = await env.DB.prepare(
      "SELECT content FROM messages WHERE id = ?",
    ).bind(message?.id ?? 0).first<{ content: string }>();
    expect(updated?.content).toContain("无法识别");
  });
});
