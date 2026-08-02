import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { appendMessage, getOrCreateActiveConversation } from "../src/storage/chat-repository";
import { getRecallTrace, listRecallTraces, saveRecallTrace } from "../src/storage/memory-recall-repository";
import { pairOwner } from "../src/storage/owner-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM memory_recall_items;
    DELETE FROM memory_recall_traces;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
});

it("stores only selected memory evidence and score components", async () => {
  const owner = await pairOwner(env.DB, 701, 801, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const assistant = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "assistant",
    mode: "persona",
    content: "嗯嗯",
    createdAt: NOW,
  });
  const traceId = await saveRecallTrace(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    assistantMessageId: assistant.messageId,
    queryHash: "a".repeat(64),
    explicitHistory: true,
    model: "deepseek-v4-flash",
    personaVersion: 8,
    items: [{
      entityKind: "graph",
      entityId: 9,
      factKey: "study_plan",
      factValue: "准备研究生考试",
      category: "goal",
      confidence: "high",
      channel: "graph",
      relevanceScore: 700,
      updatedAt: NOW,
      sourceMessageId: 123,
      status: "active",
      control: "normal",
      totalScore: 1_150,
      components: { relevance: 700, confidence: 250, recency: 120, control: 0, channel: 80, diversity: 0 },
      reasonCodes: ["graph_connection", "high_confidence"],
    }],
    now: NOW,
  });

  expect(await listRecallTraces(env.DB, owner.ownerId, 10)).toEqual([
    expect.objectContaining({ id: traceId, itemCount: 1, explicitHistory: true }),
  ]);
  expect(await getRecallTrace(env.DB, owner.ownerId, traceId)).toEqual(
    expect.objectContaining({
      queryHash: "a".repeat(64),
      items: [expect.objectContaining({
        entityKind: "graph",
        factValue: "准备研究生考试",
        reasonCodes: ["graph_connection", "high_confidence"],
      })],
    }),
  );
});
