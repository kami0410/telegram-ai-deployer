import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { appendMessage, getOrCreateActiveConversation } from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import {
  canShowAutomaticAdjustment,
  getLatestAdjustableReply,
  getRecentReplyFeedback,
  markAdjustmentShown,
  recordReplyContext,
  saveReplyFeedback,
} from "../src/storage/reply-feedback-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM reply_feedback; DELETE FROM reply_contexts; DELETE FROM messages; DELETE FROM conversations; DELETE FROM owners;");
});

async function assistantFixture(content = "先别急着怪自己呀") {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  await appendMessage(env.DB, { ownerId: owner.ownerId, conversationId: conversation.conversationId, role: "user", mode: "persona", content: "我有点焦虑", createdAt: NOW });
  const assistant = await appendMessage(env.DB, { ownerId: owner.ownerId, conversationId: conversation.conversationId, role: "assistant", mode: "persona", content, createdAt: NOW + 1 });
  await recordReplyContext(env.DB, {
    ownerId: owner.ownerId,
    assistantMessageId: assistant.messageId,
    intent: "anxiety",
    stage: "validate",
    memoryRefs: [],
    bubbleCount: 2,
    charCount: content.length,
    candidate: true,
    now: NOW + 1,
  });
  return { owner, assistant };
}

it("shows adjustment only for a candidate and enforces daily, cadence and click cooldowns", async () => {
  const { owner, assistant } = await assistantFixture();
  expect(await canShowAutomaticAdjustment(env.DB, owner.ownerId, assistant.messageId, NOW + 2)).toBe(true);
  await markAdjustmentShown(env.DB, owner.ownerId, assistant.messageId, NOW + 2);
  expect(await canShowAutomaticAdjustment(env.DB, owner.ownerId, assistant.messageId, NOW + 3)).toBe(false);
  await saveReplyFeedback(env.DB, { ownerId: owner.ownerId, assistantMessageId: assistant.messageId, kind: "too_long", now: NOW + 4 });
  expect(await getRecentReplyFeedback(env.DB, owner.ownerId, NOW + 5)).toEqual([expect.objectContaining({ kind: "too_long" })]);
});

it("finds the latest Persona reply for /adjust", async () => {
  const { owner, assistant } = await assistantFixture();
  expect(await getLatestAdjustableReply(env.DB, owner.ownerId)).toEqual({
    assistantMessageId: assistant.messageId,
    content: assistant.content,
  });
});
