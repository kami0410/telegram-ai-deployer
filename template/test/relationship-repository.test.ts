import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { appendMessage, getOrCreateActiveConversation } from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import {
  getActiveRelationshipStates,
  saveRelationshipStates,
} from "../src/storage/relationship-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM relationship_states; DELETE FROM messages; DELETE FROM conversations; DELETE FROM owners;");
});

async function fixture() {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const message = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "persona",
    content: "我明天考完再跟你说结果",
    createdAt: NOW,
  });
  return { ownerId: owner.ownerId, conversationId: conversation.conversationId, messageId: message.messageId };
}

it("stores grounded relationship states and expires temporary ones", async () => {
  const source = await fixture();
  await saveRelationshipStates(env.DB, {
    ...source,
    states: [
      { kind: "open_thread", value: "等待 OWNER 考完分享结果", sourceMessageId: source.messageId },
      { kind: "shared_moment", value: "OWNER 主动约定考后分享结果", sourceMessageId: source.messageId },
    ],
    now: NOW,
  });

  expect(await getActiveRelationshipStates(env.DB, source.ownerId, NOW + 1)).toHaveLength(2);
  expect(await getActiveRelationshipStates(env.DB, source.ownerId, NOW + 31 * 86_400))
    .toEqual([expect.objectContaining({ kind: "shared_moment" })]);
});

it("rejects a state whose source message does not belong to the owner", async () => {
  const source = await fixture();
  await expect(saveRelationshipStates(env.DB, {
    ...source,
    states: [{ kind: "commitment", value: "虚构约定", sourceMessageId: source.messageId + 99 }],
    now: NOW,
  })).rejects.toThrow("relationship_source_not_found");
});
