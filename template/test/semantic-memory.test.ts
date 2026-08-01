import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import {
  claimVectorSyncJob,
  saveMemoryExtraction,
} from "../src/storage/semantic-memory-repository";
import {
  embedTexts,
  getSemanticRelevantMemories,
  syncVectorJob,
} from "../src/semantic-memory";

const NOW = 1_750_000_000;
const VECTOR = Array.from({ length: 1_024 }, (_, index) => index / 1_024);

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM memory_vector_jobs;
    DELETE FROM memory_conflicts;
    DELETE FROM memory_episodes;
    DELETE FROM memory_facts;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
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
    content: "最近复习压力很大，担心考不好",
    createdAt: NOW,
  });
  return { ownerId: owner.ownerId, conversationId: conversation.conversationId, messageId: message.messageId };
}

it("validates multilingual embedding dimensions", async () => {
  const ai = { run: vi.fn(async () => ({ data: [VECTOR] })) };
  await expect(embedTexts(ai, ["考试焦虑"])).resolves.toEqual([VECTOR]);
  expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-m3", { text: ["考试焦虑"] });
  await expect(embedTexts({ run: async () => ({ data: [[1, 2]] }) }, ["x"]))
    .rejects.toThrow("embedding_dimensions_invalid");
});

it("upserts a vector with routing metadata but without raw memory text", async () => {
  const source = await fixture();
  await saveMemoryExtraction(env.DB, {
    ...source,
    stableFacts: [{
      category: "study",
      factKey: "study_target",
      factValue: "准备期末考试",
      confidence: "high",
      sourceMessageId: source.messageId,
    }],
    episodes: [],
    now: NOW,
  });
  const job = await claimVectorSyncJob(env.DB, source.ownerId, NOW + 1);
  if (job === null) throw new Error("job_missing");
  const upsert = vi.fn(async () => ({ mutationId: "m1" }));
  await syncVectorJob(env.DB, { run: async () => ({ data: [VECTOR] }) }, {
    upsert,
    deleteByIds: async () => ({ mutationId: "m2" }),
    query: async () => ({ matches: [] }),
  }, job, NOW + 2);
  const payload = (upsert.mock.calls as unknown[][])[0]?.[0] as
    Array<{ id: string; namespace: string; metadata: Record<string, unknown> }> | undefined;
  expect(payload?.[0]).toMatchObject({
    id: expect.stringMatching(/^fact:/),
    namespace: `owner:${source.ownerId}`,
    metadata: { owner_id: source.ownerId, kind: "fact", category: "study", active: true },
  });
  expect(JSON.stringify(payload)).not.toContain("准备期末考试");
});

it("returns an old episode only for an explicit history query and degrades safely", async () => {
  const source = await fixture();
  const saved = await saveMemoryExtraction(env.DB, {
    ...source,
    stableFacts: [],
    episodes: [{
      category: "study",
      content: "考试前复习压力很大并担心考不好",
      people: ["用户"],
      topics: ["考试"],
      occurredAt: NOW,
      sourceMessageId: source.messageId,
    }],
    now: NOW,
  });
  const id = saved.records[0]!.id;
  const ai = { run: async () => ({ data: [VECTOR] }) };
  const index = {
    upsert: async () => ({ mutationId: "m1" }),
    deleteByIds: async () => ({ mutationId: "m2" }),
    query: async () => ({ matches: [{ id: `episode:${id}`, score: 0.91 }] }),
  };
  const later = NOW + 31 * 86_400;
  await expect(getSemanticRelevantMemories(env.DB, ai, index, source.ownerId, "最近怎么样", later, false)).resolves.toEqual([]);
  await expect(getSemanticRelevantMemories(env.DB, ai, index, source.ownerId, "上次考试焦虑", later, true)).resolves.toMatchObject([
    { factKey: `episode:${id}`, category: "study" },
  ]);
  await expect(getSemanticRelevantMemories(env.DB, ai, {
    ...index,
    query: async () => ({ matches: [{ id: `episode:${id}`, score: 0.2 }] }),
  }, source.ownerId, "上次考试焦虑", later, true)).resolves.toEqual([]);
  await expect(getSemanticRelevantMemories(
    env.DB,
    { run: async () => { throw new Error("ai_down"); } },
    index,
    source.ownerId,
    "上次考试焦虑",
    later,
    true,
  )).resolves.toEqual([]);
});
