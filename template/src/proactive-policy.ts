export type ProactiveDecisionKind = "send" | "skip" | "defer";
export interface ProactiveDecision {
  decision: ProactiveDecisionKind;
  reasonCode: string;
  noveltyScore: number;
  nextCheckAt: number | null;
}

export interface ProactivePolicyInput {
  now: number;
  allowedNow: boolean;
  hasPendingReply: boolean;
  consecutiveUnanswered: number;
  lastProactiveAt: number | null;
  meaningfulCandidate: boolean;
  duplicateTopic: boolean;
  noveltyScore: number;
}

const HOUR = 3_600;
export function evaluateProactivePolicy(input: ProactivePolicyInput): ProactiveDecision {
  if (!input.allowedNow) return { decision: "skip", reasonCode: "disabled_or_quiet", noveltyScore: 0, nextCheckAt: null };
  if (input.hasPendingReply) return { decision: "defer", reasonCode: "pending_reply", noveltyScore: 0, nextCheckAt: input.now + HOUR };
  if (input.consecutiveUnanswered >= 2) return { decision: "skip", reasonCode: "unanswered_limit", noveltyScore: 0, nextCheckAt: input.now + 12 * HOUR };
  if (input.lastProactiveAt !== null && input.now - input.lastProactiveAt < 4 * HOUR) return { decision: "defer", reasonCode: "minimum_gap", noveltyScore: 0, nextCheckAt: input.lastProactiveAt + 4 * HOUR };
  if (!input.meaningfulCandidate) return { decision: "skip", reasonCode: "no_meaningful_candidate", noveltyScore: 0, nextCheckAt: input.now + 6 * HOUR };
  if (input.duplicateTopic) return { decision: "skip", reasonCode: "duplicate_topic", noveltyScore: input.noveltyScore, nextCheckAt: input.now + 6 * HOUR };
  return { decision: "send", reasonCode: "eligible", noveltyScore: Math.max(0, Math.min(1_000, Math.round(input.noveltyScore))), nextCheckAt: null };
}
