import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { appendMessage, getOrCreateActiveConversation } from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import { getActiveIdentityCore, promoteIdentityCandidate, recordIdentityEvidence } from "../src/storage/identity-core-repository";

const NOW = 1_800_000_000;
beforeEach(async () => {
  await env.DB.exec("DELETE FROM identity_core_history; DELETE FROM identity_evidence; DELETE FROM identity_candidates; DELETE FROM identity_core_entries; DELETE FROM messages; DELETE FROM conversations; DELETE FROM owners;");
});

async function fixture() {
  const owner = await pairOwner(env.DB, 77, 77, NOW); if (!owner) throw new Error("owner");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const add = (role: "user" | "assistant", content: string, update: number) => appendMessage(env.DB, { ownerId: owner.ownerId, conversationId: conversation.conversationId, role, mode: "persona", content, telegramMessageId: update, telegramUpdateId: update, createdAt: NOW + update });
  return { owner, add };
}

describe("stable Identity Core", () => {
  it("requires independent user evidence and explicit promotion", async () => {
    const { owner, add } = await fixture();
    const first = await add("user", "她遇到严肃问题会讲理由", 1);
    const second = await add("user", "她一般先分析再下结论", 2);
    let candidate = await recordIdentityEvidence(env.DB, { ownerId: owner.ownerId, identityKey: "reasoning.style", identityValue: "先讲理由，再明确给结论", sourceMessageId: first.messageId, now: NOW + 10 });
    expect(candidate.status).toBe("candidate");
    candidate = await recordIdentityEvidence(env.DB, { ownerId: owner.ownerId, identityKey: "reasoning.style", identityValue: "先讲理由，再明确给结论", sourceMessageId: second.messageId, now: NOW + 20 });
    expect(candidate).toMatchObject({ status: "ready", evidenceCount: 2 });
    expect(await getActiveIdentityCore(env.DB, owner.ownerId)).toEqual([]);
    expect(await promoteIdentityCandidate(env.DB, owner.ownerId, candidate.id, NOW + 30)).toBe(true);
    expect(await getActiveIdentityCore(env.DB, owner.ownerId)).toMatchObject([{ identityKey: "reasoning.style", version: 1 }]);
  });

  it("rejects assistant text as identity evidence", async () => {
    const { owner, add } = await fixture(); const assistant = await add("assistant", "我是乐观的人", 3);
    await expect(recordIdentityEvidence(env.DB, { ownerId: owner.ownerId, identityKey: "temperament", identityValue: "乐观", sourceMessageId: assistant.messageId, now: NOW + 30 })).rejects.toThrow("identity_evidence_requires_user_message");
  });
});
