import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { pairOwner } from "../src/storage/owner-repository";
import { attachProactiveOutcome, getProactiveStats, isRecentProactiveTopic, markProactiveSent, recordProactiveDecision } from "../src/storage/proactive-decision-repository";
import { appendMessage, getOrCreateActiveConversation } from "../src/storage/chat-repository";
const NOW = 1_800_000_000;
beforeEach(async () => { await env.DB.exec("DELETE FROM proactive_decisions; DELETE FROM owners;"); });
it("records decisions, prevents recent duplicates and attaches outcomes", async () => {
  const owner = await pairOwner(env.DB, 9, 9, NOW); if (!owner) throw new Error("owner");
  await recordProactiveDecision(env.DB, { ownerId: owner.ownerId, decision: "send", reasonCode: "eligible", topicKey: "open:1", noveltyScore: 800, unansweredCount: 0, scheduledAt: NOW, now: NOW });
  expect(await isRecentProactiveTopic(env.DB, owner.ownerId, "open:1", NOW - 10)).toBe(true);
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const message = await appendMessage(env.DB, { ownerId: owner.ownerId, conversationId: conversation.conversationId, role: "assistant", mode: "persona", content: "在干啥呀", telegramMessageId: 1, telegramUpdateId: 1, createdAt: NOW });
  await markProactiveSent(env.DB, owner.ownerId, NOW, message.messageId);
  await attachProactiveOutcome(env.DB, owner.ownerId, NOW + 20);
  expect(await getProactiveStats(env.DB, owner.ownerId, NOW - 1)).toMatchObject([{ decision: "send", outcome: "replied", count: 1 }]);
});
