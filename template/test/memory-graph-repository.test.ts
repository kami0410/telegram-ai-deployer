import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { appendMessage, getOrCreateActiveConversation } from "../src/storage/chat-repository";
import {
  getGraphCandidates,
  resolveMemoryGraphConflict,
  upsertMemoryGraph,
} from "../src/storage/memory-graph-repository";
import { pairOwner } from "../src/storage/owner-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM memory_graph_conflicts;
    DELETE FROM memory_graph_edges;
    DELETE FROM memory_graph_sources;
    DELETE FROM memory_graph_nodes;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
});

async function fixture() {
  const owner = await pairOwner(env.DB, 501, 601, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW);
  const first = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "persona",
    content: "我准备期末考试",
    createdAt: NOW,
  });
  const second = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "persona",
    content: "我的计划改成准备研究生考试",
    createdAt: NOW + 10,
  });
  return { ownerId: owner.ownerId, first: first.messageId, second: second.messageId };
}

it("stores an idempotent sourced node", async () => {
  const source = await fixture();
  const node = {
    type: "goal" as const,
    key: "study_plan",
    value: "准备期末考试",
    confidence: "high" as const,
    sourceMessageId: source.first,
  };
  expect(await upsertMemoryGraph(env.DB, {
    ownerId: source.ownerId,
    nodes: [node], edges: [], now: NOW,
  })).toMatchObject({ created: 1, unchanged: 0, conflicts: 0 });
  expect(await upsertMemoryGraph(env.DB, {
    ownerId: source.ownerId,
    nodes: [node], edges: [], now: NOW + 1,
  })).toMatchObject({ created: 0, unchanged: 1, conflicts: 0 });
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_graph_nodes").first())
    .toEqual({ count: 1 });
});

it("keeps the active node when changed evidence is unresolved", async () => {
  const source = await fixture();
  await upsertMemoryGraph(env.DB, {
    ownerId: source.ownerId,
    nodes: [{ type: "goal", key: "study_plan", value: "准备期末考试", confidence: "high", sourceMessageId: source.first }],
    edges: [], now: NOW,
  });
  const changed = await upsertMemoryGraph(env.DB, {
    ownerId: source.ownerId,
    nodes: [{ type: "goal", key: "study_plan", value: "准备研究生考试", confidence: "high", sourceMessageId: source.second }],
    edges: [], now: NOW + 10,
  });
  expect(changed.conflicts).toBe(1);
  expect((await getGraphCandidates(env.DB, source.ownerId, "study_plan", 5))[0]?.value)
    .toBe("准备期末考试");

  const conflict = await env.DB.prepare(
    "SELECT id FROM memory_graph_conflicts WHERE owner_id = ? AND status = 'pending'",
  ).bind(source.ownerId).first<{ id: number }>();
  expect(conflict).not.toBeNull();
  expect(await resolveMemoryGraphConflict(
    env.DB, source.ownerId, conflict!.id, "use_new", NOW + 20,
  )).toBe(true);
  expect((await getGraphCandidates(env.DB, source.ownerId, "study_plan", 5))[0]?.value)
    .toBe("准备研究生考试");
});

it("rejects evidence that is not an owned user message", async () => {
  const source = await fixture();
  await expect(upsertMemoryGraph(env.DB, {
    ownerId: source.ownerId,
    nodes: [{ type: "topic", key: "private", value: "虚构内容", confidence: "high", sourceMessageId: source.second + 99 }],
    edges: [], now: NOW,
  })).rejects.toThrow("memory_graph_source_not_found");
});
