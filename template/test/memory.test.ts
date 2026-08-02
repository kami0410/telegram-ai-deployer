import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendMessage,
  closeActiveConversation,
  getLatestConversationSummary,
  getPersonaMessagesAfter,
  getOrCreateActiveConversation,
  getRecentMessages,
  saveConversationSummary,
} from "../src/storage/chat-repository";
import {
  getRelevantMemoryFacts,
  upsertMemoryFacts,
} from "../src/storage/memory-repository";
import { pairOwner } from "../src/storage/owner-repository";
import { setMemoryControl } from "../src/storage/memory-control-repository";
import {
  addDailyTokenUsage,
  getDailyUsage,
  reserveDailyRequest,
} from "../src/storage/usage-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM usage_daily;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
});

async function ownerId(): Promise<number> {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  expect(owner).not.toBeNull();
  if (owner === null) throw new Error("owner_fixture_failed");
  return owner.ownerId;
}

describe("durable conversations", () => {
  it("reads the oldest unsummarized Persona messages first", async () => {
    const owner = await ownerId();
    const conversation = await getOrCreateActiveConversation(env.DB, owner, NOW + 1);
    const messages = [];
    for (let index = 0; index < 45; index += 1) {
      messages.push(await appendMessage(env.DB, {
        ownerId: owner,
        conversationId: conversation.conversationId,
        role: index % 2 === 0 ? "user" : "assistant",
        mode: "persona",
        content: `消息 ${index}`,
        createdAt: NOW + 2 + index,
      }));
    }
    await saveConversationSummary(env.DB, {
      conversationId: conversation.conversationId,
      fromMessageId: messages[0]!.messageId,
      throughMessageId: messages[1]!.messageId,
      summary: "前两条消息的摘要",
      createdAt: NOW + 50,
    });

    const pending = await getPersonaMessagesAfter(
      env.DB,
      conversation.conversationId,
      messages[1]!.messageId,
      40,
    );

    expect(pending).toHaveLength(40);
    expect(pending[0]?.messageId).toBe(messages[2]!.messageId);
    expect(pending.at(-1)?.messageId).toBe(messages[41]!.messageId);
  });

  it("retains full messages when adding rolling summaries", async () => {
    const owner = await ownerId();
    const conversation = await getOrCreateActiveConversation(env.DB, owner, NOW + 1);
    const first = await appendMessage(env.DB, {
      ownerId: owner,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "我最近在准备考试",
      telegramMessageId: 10,
      telegramUpdateId: 100,
      createdAt: NOW + 2,
    });
    const second = await appendMessage(env.DB, {
      ownerId: owner,
      conversationId: conversation.conversationId,
      role: "assistant",
      mode: "persona",
      content: "嗯嗯嗯那你最近确实蛮累的呀",
      createdAt: NOW + 3,
    });
    await saveConversationSummary(env.DB, {
      conversationId: conversation.conversationId,
      fromMessageId: first.messageId,
      throughMessageId: second.messageId,
      summary: "OWNER 在准备考试，Persona 表示理解。",
      createdAt: NOW + 4,
    });

    expect(
      await getLatestConversationSummary(env.DB, conversation.conversationId),
    ).toMatchObject({ throughMessageId: second.messageId });
    expect(await getRecentMessages(env.DB, conversation.conversationId, 10)).toEqual([
      expect.objectContaining({ messageId: first.messageId, content: "我最近在准备考试" }),
      expect.objectContaining({ messageId: second.messageId, role: "assistant" }),
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first(),
    ).toEqual({ count: 2 });

    expect(
      await closeActiveConversation(env.DB, owner, NOW + 5),
    ).toBe(true);
    const next = await getOrCreateActiveConversation(env.DB, owner, NOW + 6);
    expect(next.conversationId).not.toBe(conversation.conversationId);
  });
});

describe("grounded long-term facts", () => {
  it("upserts grounded facts and ranks matches deterministically", async () => {
    const owner = await ownerId();
    const conversation = await getOrCreateActiveConversation(env.DB, owner, NOW + 1);
    const fruitSource = await appendMessage(env.DB, {
      ownerId: owner,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "我最近喜欢吃蓝莓",
      createdAt: NOW + 2,
    });
    const studySource = await appendMessage(env.DB, {
      ownerId: owner,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "我在复习高数",
      createdAt: NOW + 3,
    });

    await upsertMemoryFacts(env.DB, owner, conversation.conversationId, [
      {
        category: "preference",
        factKey: "favorite_fruit",
        factValue: "OWNER 最近喜欢吃蓝莓",
        confidence: "high",
        sourceMessageId: fruitSource.messageId,
      },
      {
        category: "study",
        factKey: "current_subject",
        factValue: "OWNER 在复习高数",
        confidence: "medium",
        sourceMessageId: studySource.messageId,
      },
    ], NOW + 4);

    const fruit = await getRelevantMemoryFacts(
      env.DB,
      owner,
      "最近吃什么水果",
      2,
      NOW + 5,
    );
    expect(fruit[0]).toMatchObject({
      factKey: "favorite_fruit",
      confidence: "high",
    });
    expect(fruit).toHaveLength(1);

    await upsertMemoryFacts(env.DB, owner, conversation.conversationId, [
      {
        category: "preference",
        factKey: "favorite_fruit",
        factValue: "OWNER 现在更喜欢吃草莓",
        confidence: "high",
        sourceMessageId: fruitSource.messageId,
      },
    ], NOW + 6);
    expect(
      (
        await getRelevantMemoryFacts(env.DB, owner, "草莓", 1, NOW + 7)
      )[0]?.factValue,
    ).toBe("OWNER 现在更喜欢吃草莓");
  });

  it("rejects facts whose source message does not belong to the owner", async () => {
    const owner = await ownerId();
    const conversation = await getOrCreateActiveConversation(env.DB, owner, NOW + 1);

    await expect(
      upsertMemoryFacts(env.DB, owner, conversation.conversationId, [
        {
          category: "study",
          factKey: "invented",
          factValue: "must not persist",
          confidence: "high",
          sourceMessageId: 999_999,
        },
      ], NOW + 2),
    ).rejects.toThrow("memory_source_not_found");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_facts").first(),
    ).toEqual({ count: 0 });
  });

  it("excludes ignored facts and gives pinned facts bounded recall priority", async () => {
    const owner = await ownerId();
    const conversation = await getOrCreateActiveConversation(env.DB, owner, NOW + 1);
    const source = await appendMessage(env.DB, {
      ownerId: owner,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "我喜欢蓝莓，也准备高数考试",
      createdAt: NOW + 2,
    });
    await upsertMemoryFacts(env.DB, owner, conversation.conversationId, [
      { category: "preference", factKey: "fruit", factValue: "OWNER 喜欢蓝莓", confidence: "high", sourceMessageId: source.messageId },
      { category: "study", factKey: "exam", factValue: "OWNER 准备高数考试", confidence: "high", sourceMessageId: source.messageId },
    ], NOW + 3);
    const rows = await env.DB.prepare("SELECT id, fact_key FROM memory_facts WHERE owner_id = ?").bind(owner).all<{ id: number; fact_key: string }>();
    const fruit = rows.results.find((row) => row.fact_key === "fruit");
    const exam = rows.results.find((row) => row.fact_key === "exam");
    if (fruit === undefined || exam === undefined) throw new Error("memory_fixture_failed");
    await setMemoryControl(env.DB, owner, "fact", fruit.id, "ignored", NOW + 4);
    await setMemoryControl(env.DB, owner, "fact", exam.id, "pinned", NOW + 4);

    const recalled = await getRelevantMemoryFacts(env.DB, owner, "今天聊点别的", 10, NOW + 5);
    expect(recalled.some((item) => item.sourceId === fruit.id)).toBe(false);
    expect(recalled).toEqual([expect.objectContaining({ sourceId: exam.id, sourceKind: "fact" })]);
  });
});

describe("daily usage accounting", () => {
  it("reserves requests atomically and adds tokens without bypassing the limit", async () => {
    const owner = await ownerId();
    expect(await reserveDailyRequest(env.DB, owner, "2026-07-24", 2)).toBe(true);
    expect(await reserveDailyRequest(env.DB, owner, "2026-07-24", 2)).toBe(true);
    expect(await reserveDailyRequest(env.DB, owner, "2026-07-24", 2)).toBe(false);

    await addDailyTokenUsage(env.DB, owner, "2026-07-24", 120, 30, 80, 40);
    expect(await getDailyUsage(env.DB, owner, "2026-07-24")).toEqual({
      requestCount: 2,
      inputTokens: 120,
      outputTokens: 30,
      promptCacheHitTokens: 80,
      promptCacheMissTokens: 40,
    });
  });
});
