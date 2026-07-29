import { describe, expect, it } from "vitest";
import { PERSONA_V1 } from "../src/persona/seed";
import { buildPersonaPrompt } from "../src/prompt";

describe("generic persona prompt calibration", () => {
  it("keeps safety and imported reference lower than system boundaries", () => {
    const prompt = buildPersonaPrompt({
      persona: PERSONA_V1,
      recentMessages: [],
      summary: null,
      memoryFacts: [],
      currentBeijingTime: "2026-07-29 12:00:00（北京时间，UTC+8）",
      currentMessage: "Hello",
      maxContextChars: 20_000,
    });
    const joined = prompt.messages.map((message) => message.content).join("\n");
    expect(joined).toContain("not a real person");
    expect(joined).toContain("Immediate safety risks");
    expect(joined).not.toContain("private conversation");
  });
});
