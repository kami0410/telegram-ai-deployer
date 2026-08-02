import { describe, expect, it } from "vitest";
import { evaluateProactivePolicy } from "../src/proactive-policy";
const base = { now: 100_000, allowedNow: true, hasPendingReply: false, consecutiveUnanswered: 0, lastProactiveAt: null, meaningfulCandidate: true, duplicateTopic: false, noveltyScore: 700 };
describe("selective proactive policy", () => {
  it.each([
    [{ allowedNow: false }, "disabled_or_quiet", "skip"],
    [{ hasPendingReply: true }, "pending_reply", "defer"],
    [{ consecutiveUnanswered: 2 }, "unanswered_limit", "skip"],
    [{ lastProactiveAt: 99_000 }, "minimum_gap", "defer"],
    [{ meaningfulCandidate: false }, "no_meaningful_candidate", "skip"],
    [{ duplicateTopic: true }, "duplicate_topic", "skip"],
  ] as const)("blocks %j", (override, reasonCode, decision) => {
    expect(evaluateProactivePolicy({ ...base, ...override })).toMatchObject({ reasonCode, decision });
  });
  it("allows a novel meaningful contact", () => expect(evaluateProactivePolicy(base)).toMatchObject({ decision: "send", reasonCode: "eligible" }));
});
