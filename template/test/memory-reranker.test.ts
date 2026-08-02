import { expect, it } from "vitest";
import { rankMemoryCandidates, type MemoryRetrievalCandidate } from "../src/memory-reranker";

const NOW = 1_750_000_000;

function candidate(
  id: number,
  overrides: Partial<MemoryRetrievalCandidate> = {},
): MemoryRetrievalCandidate {
  return {
    entityKind: "fact",
    entityId: id,
    factKey: `fact_${id}`,
    factValue: `value_${id}`,
    category: "study",
    confidence: "medium",
    channel: "semantic",
    relevanceScore: 500,
    updatedAt: NOW - 40 * 86_400,
    status: "active",
    control: "normal",
    ...overrides,
  };
}

it("ranks confirmed pinned evidence above semantic similarity alone", () => {
  const ranked = rankMemoryCandidates([
    candidate(1, { relevanceScore: 920, confidence: "low" }),
    candidate(2, {
      relevanceScore: 420,
      confidence: "high",
      control: "pinned",
      updatedAt: NOW - 86_400,
    }),
  ], { now: NOW, limit: 2, explicitHistory: false });

  expect(ranked.map((item) => item.entityId)).toEqual([2, 1]);
  expect(ranked[0]?.reasonCodes).toContain("user_pinned");
});

it("excludes conflicted superseded and ignored candidates", () => {
  const ranked = rankMemoryCandidates([
    candidate(1, { status: "conflicted" }),
    candidate(2, { status: "superseded" }),
    candidate(3, { control: "ignored" }),
    candidate(4),
  ], { now: NOW, limit: 10, explicitHistory: false });
  expect(ranked.map((item) => item.entityId)).toEqual([4]);
});

it("uses a diversity penalty when scores are otherwise close", () => {
  const ranked = rankMemoryCandidates([
    candidate(1, { relevanceScore: 700, category: "study" }),
    candidate(2, { relevanceScore: 690, category: "study" }),
    candidate(3, { relevanceScore: 650, category: "relationship" }),
  ], { now: NOW, limit: 2, explicitHistory: false });
  expect(ranked.map((item) => item.entityId)).toEqual([1, 3]);
});
