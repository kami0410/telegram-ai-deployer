import { describe, expect, it } from "vitest";
import {
  evaluateSyntheticReply,
  summarizeEvaluation,
  type SyntheticQualityScenario,
} from "../src/quality-evaluation";
import qualitySet from "../config/realism-scenarios-v2.json";

describe("synthetic quality evaluation", () => {
  it("ships a versioned gold set with at least one hundred unique scenarios", () => {
    expect(qualitySet.version).toBe(2);
    expect(qualitySet.scenarios.length).toBeGreaterThanOrEqual(100);
    expect(new Set(qualitySet.scenarios.map((scenario) => scenario.id)).size).toBe(
      qualitySet.scenarios.length,
    );
    expect(qualitySet.scenarios.every((scenario) => scenario.dimensions.length > 0)).toBe(true);
  });

  it("fails a critical forbidden expression", () => {
    const scenario: SyntheticQualityScenario = {
      id: "narration",
      user: "你在干什么呀",
      dimensions: ["persona"],
      critical: true,
      maxChars: 100,
      forbidden: ["（她看着手机）"],
    };

    expect(evaluateSyntheticReply(scenario, "（她看着手机）怎么了呀")).toEqual({
      id: "narration",
      passed: false,
      critical: true,
      dimensions: ["persona"],
      failures: ["forbidden:（她看着手机）"],
    });
  });

  it("summarizes critical failures and dimension pass rates", () => {
    const summary = summarizeEvaluation([
      {
        id: "a",
        passed: true,
        critical: true,
        dimensions: ["memory"],
        failures: [],
      },
      {
        id: "b",
        passed: false,
        critical: true,
        dimensions: ["memory"],
        failures: ["too_long"],
      },
    ]);

    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.criticalFailures).toBe(1);
    expect(summary.dimensions.memory).toEqual({ total: 2, passed: 1, passRate: 0.5 });
  });
});
