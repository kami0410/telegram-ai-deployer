import { describe, expect, it } from "vitest";
import { detectRepairSignal } from "../src/interaction-repair";

describe("implicit interaction repair", () => {
  it("recognizes only explicit high precision repair phrases", () => {
    expect(detectRepairSignal({ text: "太长了，短一点" })?.kind).toBe("shorten");
    expect(detectRepairSignal({ text: "别问了" })?.kind).toBe("stop_questions");
    expect(detectRepairSignal({ text: "换个话题吧" })?.kind).toBe("change_topic");
    expect(detectRepairSignal({ text: "不是，我说的是明天" })?.kind).toBe("correction");
    expect(detectRepairSignal({ text: "今天有点长" })).toBeNull();
  });

  it("turns redo into temporary guidance", () => {
    expect(detectRepairSignal({ text: "再来", redo: true })).toMatchObject({ kind: "redo", expiresAfterSeconds: 3600 });
  });
});
