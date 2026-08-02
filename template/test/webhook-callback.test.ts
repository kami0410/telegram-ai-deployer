import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { handleWebhook } from "../src/webhook";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import {
  confirmPersonaDraft,
  createPersonaDraft,
  getCurrentPersona,
  seedPersona,
} from "../src/storage/persona-repository";
import { saveMemoryExtraction } from "../src/storage/semantic-memory-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM management_events;
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM processed_updates;
    DELETE FROM owners;
  `);
});

function request(
  updateId: number,
  draftId: string,
  action: "c" | "r" | "x" = "c",
): Request {
  return new Request("https://yuan.example/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-only-webhook-secret" },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 101, is_bot: false },
        message: { message_id: 88, chat: { id: 201, type: "private" } },
        data: `pd:${action}:${draftId}`,
      },
    }),
  });
}

function memoryConflictRequest(updateId: number, conflictId: string, action: "n" | "k"): Request {
  return new Request("https://yuan.example/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-only-webhook-secret" },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 101, is_bot: false },
        message: { message_id: 89, chat: { id: 201, type: "private" } },
        data: `mc:${action}:${conflictId}`,
      },
    }),
  });
}

function adjustmentRequest(updateId: number, data: string): Request {
  return new Request("https://yuan.example/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-only-webhook-secret" },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 101, is_bot: false },
        message: { message_id: 90, chat: { id: 201, type: "private" } },
        data,
      },
    }),
  });
}

it("opens adjustment choices and stores one narrow reply correction", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const assistant = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "assistant",
    mode: "persona",
    content: "你应该这样做呀",
    createdAt: NOW,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    calls.push({
      method: new URL(String(input)).pathname.split("/").at(-1) ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ ok: true, result: true });
  });
  const deps = { fetcher, queue: { send: async () => undefined }, now: () => NOW + 1 };

  await handleWebhook(adjustmentRequest(6101, `ra:o:${assistant.messageId}`), env, deps);
  const opened = calls.find((call) => call.method === "editMessageReplyMarkup");
  expect(JSON.stringify(opened?.body.reply_markup)).toContain("别急着建议");
  expect(JSON.stringify(opened?.body.reply_markup)).toContain(`ra:f:n:${assistant.messageId}`);

  await handleWebhook(adjustmentRequest(6102, `ra:f:n:${assistant.messageId}`), env, {
    ...deps,
    now: () => NOW + 2,
  });
  expect(await env.DB.prepare(
    "SELECT kind FROM reply_feedback WHERE owner_id = ? AND assistant_message_id = ?",
  ).bind(owner.ownerId, assistant.messageId).first()).toEqual({ kind: "no_advice" });
});

it("confirms an owned draft idempotently through opaque callback data", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const persona = await seedPersona(env.DB, owner.ownerId, NOW);
  const draft = await createPersonaDraft(env.DB, {
    ownerId: owner.ownerId,
    operation: "addition",
    summary: "新增兴趣",
    impactScope: "interests.topics",
    patch: [{ path: "interests.topics", value: [...persona.snapshot.interests.topics, "摄影"] }],
    now: NOW,
  });
  const callbackTexts: string[] = [];
  const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    telegramCalls.push({
      method: new URL(String(input)).pathname.split("/").at(-1) ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    if (String(input).endsWith("/answerCallbackQuery")) {
      const body = JSON.parse(String(init?.body)) as { text?: string };
      if (body.text !== undefined) callbackTexts.push(body.text);
    }
    return Response.json({ ok: true, result: true });
  });
  const deps = { fetcher, queue: { send: async () => undefined }, now: () => NOW + 1 };
  expect((await handleWebhook(request(5001, draft.draftId), env, deps)).status).toBe(200);
  expect((await getCurrentPersona(env.DB, owner.ownerId))?.version).toBe(2);
  expect((await handleWebhook(request(5002, draft.draftId), env, deps)).status).toBe(200);
  expect((await getCurrentPersona(env.DB, owner.ownerId))?.version).toBe(2);
  expect(callbackTexts).toEqual(["已确认并生效", "这个草稿已经处理或过期了"]);
  expect(telegramCalls).toContainEqual({
    method: "editMessageText",
    body: {
      chat_id: 201,
      message_id: 88,
      text: "人格草稿已确认并生效",
    },
  });
});

it("shows terminal status for cancel and accepted regeneration", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const persona = await seedPersona(env.DB, owner.ownerId, NOW);
  const cancelledDraft = await createPersonaDraft(env.DB, {
    ownerId: owner.ownerId,
    operation: "addition",
    summary: "取消草稿",
    impactScope: "interests.topics",
    patch: [{ path: "interests.topics", value: [...persona.snapshot.interests.topics, "摄影"] }],
    now: NOW,
  });
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const source = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "system",
    content: "新增兴趣",
    telegramUpdateId: 7001,
    telegramMessageId: 77,
    createdAt: NOW,
  });
  const regeneratedDraft = await createPersonaDraft(env.DB, {
    ownerId: owner.ownerId,
    operation: "addition",
    summary: "重新生成草稿",
    impactScope: "interests.topics",
    patch: [{ path: "interests.topics", value: [...persona.snapshot.interests.topics, "摄影"] }],
    sourceMessageId: source.messageId,
    now: NOW,
  });
  const edits: string[] = [];
  const queued: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/editMessageText")) {
      const body = JSON.parse(String(init?.body)) as { text: string };
      edits.push(body.text);
    }
    return Response.json({ ok: true, result: true });
  });
  const deps = {
    fetcher,
    queue: { send: async (job: unknown) => { queued.push(job); } },
    now: () => NOW + 1,
  };

  expect((await handleWebhook(request(5101, cancelledDraft.draftId, "x"), env, deps)).status).toBe(200);
  expect((await handleWebhook(request(5102, regeneratedDraft.draftId, "r"), env, deps)).status).toBe(200);
  expect(edits).toEqual(["人格草稿已取消", "正在重新生成人格草稿…"]);
  expect(queued).toHaveLength(1);
  expect(await env.DB.prepare(
    "SELECT id FROM persona_change_drafts WHERE id = ? AND owner_id = ?",
  ).bind(regeneratedDraft.draftId, owner.ownerId).first()).toBeNull();
  expect((await confirmPersonaDraft(
    env.DB,
    owner.ownerId,
    regeneratedDraft.draftId,
    NOW + 2,
  )).ok).toBe(false);

  const retryableDraft = await createPersonaDraft(env.DB, {
    ownerId: owner.ownerId,
    operation: "addition",
    summary: "排队失败后可重试",
    impactScope: "interests.topics",
    patch: [{ path: "interests.topics", value: [...persona.snapshot.interests.topics, "摄影"] }],
    sourceMessageId: source.messageId,
    now: NOW,
  });
  await expect(handleWebhook(request(5103, retryableDraft.draftId, "r"), env, {
    fetcher,
    queue: { send: async () => { throw new Error("queue_unavailable"); } },
    now: () => NOW + 1,
  })).rejects.toThrow("queue_unavailable");
  expect(await env.DB.prepare(
    "SELECT summary FROM persona_change_drafts WHERE id = ? AND owner_id = ?",
  ).bind(retryableDraft.draftId, owner.ownerId).first()).toEqual({ summary: "排队失败后可重试" });
});

it("keeps a confirmed persona when Telegram cannot edit the status message", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const persona = await seedPersona(env.DB, owner.ownerId, NOW);
  const draft = await createPersonaDraft(env.DB, {
    ownerId: owner.ownerId,
    operation: "addition",
    summary: "新增兴趣",
    impactScope: "interests.topics",
    patch: [{ path: "interests.topics", value: [...persona.snapshot.interests.topics, "摄影"] }],
    now: NOW,
  });
  const answered: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (String(input).endsWith("/editMessageText")) {
      return Response.json({ ok: false, error_code: 400 }, { status: 400 });
    }
    if (String(input).endsWith("/answerCallbackQuery")) answered.push("answered");
    return Response.json({ ok: true, result: true });
  });

  expect((await handleWebhook(request(5201, draft.draftId), env, {
    fetcher,
    queue: { send: async () => undefined },
    now: () => NOW + 1,
  })).status).toBe(200);
  expect(answered).toEqual(["answered"]);
  expect((await getCurrentPersona(env.DB, owner.ownerId))?.version).toBe(2);
});

it("resolves memory conflicts through opaque idempotent callbacks", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const source = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "persona",
    content: "我的目标变了",
    createdAt: NOW,
  });
  const original = {
    category: "goal" as const,
    factKey: "current_goal",
    factValue: "准备期末考试",
    confidence: "high" as const,
    sourceMessageId: source.messageId,
  };
  await saveMemoryExtraction(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    stableFacts: [original],
    episodes: [],
    now: NOW,
  });
  const changed = await saveMemoryExtraction(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    stableFacts: [{ ...original, factValue: "准备研究生考试" }],
    episodes: [],
    now: NOW + 1,
  });
  const conflictId = changed.conflicts[0]!.conflictId;
  const edits: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/editMessageText")) {
      edits.push((JSON.parse(String(init?.body)) as { text: string }).text);
    }
    return Response.json({ ok: true, result: true });
  });
  const deps = { fetcher, queue: { send: async () => undefined }, now: () => NOW + 2 };

  expect((await handleWebhook(memoryConflictRequest(5301, conflictId, "n"), env, deps)).status).toBe(200);
  expect((await handleWebhook(memoryConflictRequest(5302, conflictId, "n"), env, deps)).status).toBe(200);
  expect(await env.DB.prepare("SELECT fact_value FROM memory_facts WHERE fact_key = 'current_goal'").first()).toEqual({ fact_value: "准备研究生考试" });
  expect(edits).toEqual(["已使用新记忆"]);
});

it("returns a Web App button for /settings", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  const update = {
    update_id: 6001,
    message: {
      message_id: 9,
      date: NOW,
      from: { id: 101, is_bot: false },
      chat: { id: 201, type: "private" },
      text: "/settings",
    },
  };
  await handleWebhook(new Request("https://yuan.example/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "test-only-webhook-secret" },
    body: JSON.stringify(update),
  }), env, { fetcher, queue: { send: async () => undefined }, now: () => NOW });
  expect(JSON.stringify(bodies)).toContain('"web_app":{"url":"https://yuan.example/app"}');
});
