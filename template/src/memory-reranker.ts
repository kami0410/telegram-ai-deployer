export type MemoryEntityKind = "fact" | "episode" | "graph";
export type MemoryRetrievalChannel = "lexical" | "semantic" | "graph" | "pinned";
export type MemoryCandidateStatus = "active" | "conflicted" | "superseded" | "ignored";
export type MemoryCandidateControl = "normal" | "pinned" | "ignored";

export interface MemoryRetrievalCandidate {
  entityKind: MemoryEntityKind;
  entityId: number;
  factKey: string;
  factValue: string;
  category: string;
  confidence: "low" | "medium" | "high";
  channel: MemoryRetrievalChannel;
  relevanceScore: number;
  updatedAt: number;
  sourceMessageId?: number;
  status: MemoryCandidateStatus;
  control: MemoryCandidateControl;
}

export interface RankedMemoryCandidate extends MemoryRetrievalCandidate {
  totalScore: number;
  components: {
    relevance: number;
    confidence: number;
    recency: number;
    control: number;
    channel: number;
    diversity: number;
  };
  reasonCodes: string[];
}

function boundedScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1_000, Math.round(value)));
}

function confidenceScore(value: MemoryRetrievalCandidate["confidence"]): number {
  if (value === "high") return 250;
  if (value === "medium") return 120;
  return 0;
}

function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  if (age <= 7 * 86_400) return 120;
  if (age <= 30 * 86_400) return 80;
  if (age <= 180 * 86_400) return 40;
  return 0;
}

function channelScore(channel: MemoryRetrievalChannel, explicitHistory: boolean): number {
  if (channel === "pinned") return 120;
  if (channel === "graph") return 80;
  if (channel === "lexical") return explicitHistory ? 90 : 60;
  return explicitHistory ? 70 : 40;
}

function baseRank(
  candidate: MemoryRetrievalCandidate,
  now: number,
  explicitHistory: boolean,
): RankedMemoryCandidate {
  const components = {
    relevance: boundedScore(candidate.relevanceScore),
    confidence: confidenceScore(candidate.confidence),
    recency: recencyScore(candidate.updatedAt, now),
    control: candidate.control === "pinned" ? 600 : 0,
    channel: channelScore(candidate.channel, explicitHistory),
    diversity: 0,
  };
  const reasonCodes = [
    candidate.channel === "semantic" ? "semantic_relevance"
      : candidate.channel === "graph" ? "graph_connection"
        : candidate.channel === "pinned" ? "user_pinned" : "lexical_relevance",
  ];
  if (candidate.control === "pinned" && !reasonCodes.includes("user_pinned")) {
    reasonCodes.push("user_pinned");
  }
  if (candidate.confidence === "high") reasonCodes.push("high_confidence");
  if (components.recency >= 80) reasonCodes.push("recently_confirmed");
  if (explicitHistory) reasonCodes.push("explicit_history_request");
  return {
    ...candidate,
    components,
    totalScore: Object.values(components).reduce((sum, value) => sum + value, 0),
    reasonCodes,
  };
}

export function rankMemoryCandidates(
  candidates: MemoryRetrievalCandidate[],
  context: { now: number; limit: number; explicitHistory: boolean },
): RankedMemoryCandidate[] {
  const unique = new Map<string, MemoryRetrievalCandidate>();
  for (const candidate of candidates) {
    if (candidate.status !== "active" || candidate.control === "ignored") continue;
    const key = `${candidate.entityKind}:${candidate.entityId}`;
    const existing = unique.get(key);
    if (existing === undefined || candidate.relevanceScore > existing.relevanceScore) {
      unique.set(key, candidate);
    }
  }
  const remaining = [...unique.values()].map((candidate) =>
    baseRank(candidate, context.now, context.explicitHistory)
  );
  const selected: RankedMemoryCandidate[] = [];
  const categoryCounts = new Map<string, number>();
  const limit = Math.max(0, Math.min(30, Math.floor(context.limit)));
  while (selected.length < limit && remaining.length > 0) {
    for (const candidate of remaining) {
      const diversity = -100 * (categoryCounts.get(candidate.category) ?? 0);
      candidate.components.diversity = diversity;
      candidate.totalScore = Object.values(candidate.components)
        .reduce((sum, value) => sum + value, 0);
    }
    remaining.sort((left, right) =>
      right.totalScore - left.totalScore ||
      right.updatedAt - left.updatedAt ||
      left.entityKind.localeCompare(right.entityKind) ||
      left.entityId - right.entityId
    );
    const next = remaining.shift();
    if (next === undefined) break;
    selected.push(next);
    categoryCounts.set(next.category, (categoryCounts.get(next.category) ?? 0) + 1);
  }
  return selected;
}
