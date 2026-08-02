import { describe, expect, it } from "vitest";
import { sanitizePersonaReply } from "../src/persona-reply";

describe("Persona reply sanitizing", () => {
  it("removes parenthesized environment and stage narration", () => {
    expect(sanitizePersonaReply("（窗外下起雨，她轻轻笑了笑）\n怎么了呀")).toBe("怎么了呀");
    expect(sanitizePersonaReply("没事呀（她放下手机，看向窗外）你先说")).toBe("没事呀你先说");
    expect(sanitizePersonaReply("【夜色渐深，房间安静下来】嗯嗯嗯")).toBe("嗯嗯嗯");
  });

  it("preserves ordinary parenthetical clarification", () => {
    expect(sanitizePersonaReply("这个（尤其是第二点）我也觉得挺对的")).toBe(
      "这个（尤其是第二点）我也觉得挺对的",
    );
  });

  it("uses a natural fallback rather than sending narration only", () => {
    expect(sanitizePersonaReply("（她沉默了一会儿）")).toBe("怎么了呀");
  });
});
