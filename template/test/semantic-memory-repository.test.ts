import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import {
  claimVectorSyncJob,
  completeVectorSyncJob,
  loadSemanticRecords,
  queueFullVectorRebuild,
  resolveMemoryConflict,
  saveMemoryExtraction,
} from "../src/storage/semantic-memory-repository";

const NOW = 1_750_000_000;

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
    telegramMessageId: 11,
    telegramUpdateId: 12,
    createdAt: NOW,
  });
  return { ownerId: owner.ownerId, conversationId: conversation.conversationId, messageId: message.messageId };
}

it("keeps episodes indefinitely but excludes old episodes from automatic injection", async () => {
  const source = await fixture();
  const saved = await saveMemoryExtraction(env.DB, {
    ...source,
    stableFacts: [],
    episodes: [{
      category: "study",
      content: "考试前复习压力很大并担心考不好",
      people: ["用户"],
      topics: ["考试", "复习"],
      occurredAt: NOW,
      sourceMessageId: source.messageId,
    }],
    now: NOW,
  });

  expect(saved.vectorJobIds).toHaveLength(1);
  expect(await loadSemanticRecords(env.DB, source.ownerId, saved.records)).toHaveLength(1);
  expect(await loadSemanticRecords(env.DB, source.ownerId, saved.records, {
    automaticOnlyAt: NOW + 31 * 86_400,
  })).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_episodes").first()).toEqual({ count: 1 });
  await saveMemoryExtraction(env.DB, {
    ...source,
    stableFacts: [],
    episodes: [{
      category: "study",
      content: "考试前复习压力很大并担心考不好",
      people: ["用户"],
      topics: ["考试", "复习"],
      occurredAt: NOW,
      sourceMessageId: source.messageId,
    }],
    now: NOW + 10,
  });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_episodes").first()).toEqual({ count: 1 });
});

it("refreshes an equal fact but creates a pending conflict for a changed value", async () => {
  const source = await fixture();
  const original = {
    category: "study" as const,
    factKey: "study_target",
    factValue: "准备期末考试",
    confidence: "high" as const,
    sourceMessageId: source.messageId,
  };
  await saveMemoryExtraction(env.DB, { ...source, stableFacts: [original], episodes: [], now: NOW });
  const equal = await saveMemoryExtraction(env.DB, { ...source, stableFacts: [original], episodes: [], now: NOW + 10 });
  expect(equal.conflicts).toEqual([]);

  const changed = await saveMemoryExtraction(env.DB, {
    ...source,
    stableFacts: [{ ...original, factValue: "准备研究生考试" }],
    episodes: [],
    now: NOW + 20,
  });
  expect(changed.conflicts).toHaveLength(1);
  await saveMemoryExtraction(env.DB, {
    ...source,
    stableFacts: [{ ...original, factValue: "准备研究生考试" }],
    episodes: [],
    now: NOW + 21,
  });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_conflicts").first()).toEqual({ count: 1 });
  expect(await env.DB.prepare("SELECT fact_value FROM memory_facts WHERE fact_key = 'study_target'").first()).toEqual({ fact_value: "准备期末考试" });

  const resolution = await resolveMemoryConflict(
    env.DB,
    source.ownerId,
    changed.conflicts[0]!.conflictId,
    "use_new",
    NOW + 30,
  );
  expect(resolution.ok).toBe(true);
  expect(await env.DB.prepare("SELECT fact_value FROM memory_facts WHERE fact_key = 'study_target'").first()).toEqual({ fact_value: "准备研究生考试" });
});

it("claims vector jobs idempotently and can seed a full fact rebuild", async () => {
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
  const seeded = await queueFullVectorRebuild(env.DB, source.ownerId, NOW + 1);
  expect(seeded).toBe(1);
  const job = await claimVectorSyncJob(env.DB, source.ownerId, NOW + 2);
  expect(job?.entityKind).toBe("fact");
  if (job === null) throw new Error("job_missing");
  await completeVectorSyncJob(env.DB, job.jobId, NOW + 3);
  expect(await claimVectorSyncJob(env.DB, source.ownerId, NOW + 4)).toBeNull();
});
