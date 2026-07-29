import { describe, expect, it } from "vitest";
import { PERSONA_V1 } from "../src/persona/seed";
import {
  buildAskPrompt,
  buildPersonaPrompt,
  type PromptMemoryFact,
} from "../src/prompt";

const facts: PromptMemoryFact[] = [
  {
    factKey: "favorite_fruit",
    factValue: "OWNER 最近喜欢吃蓝莓",
    category: "preference",
    confidence: "high",
    priorityScore: 90,
  },
  {
    factKey: "temporary_guess",
    factValue: "一条低优先级猜测",
    category: "routine",
    confidence: "low",
    priorityScore: 10,
  },
];

describe("Persona Bot prompt construction", () => {
  it("keeps the approved layer order exactly", () => {
    const result = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: facts,
      summary: "上次聊到学习压力。",
      recentMessages: [
        { role: "user", content: "我刚刚又想了一下" },
        { role: "assistant", content: "嗯嗯嗯" },
      ],
      currentMessage: "我今天还是有点焦虑",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: 100_000,
    });

    const contents = result.messages.map((message) => message.content);
    const indexes = [
      "[SAFETY_AND_REALITY]",
      "[PERSONA]",
      "[NON_OVERRIDABLE_BOUNDARIES]",
      "[HIGH_CONFIDENCE_PERSONA_FACTS]",
      "[CORRECTIONS_UNCERTAINTY_AND_PROHIBITIONS]",
      "[CURRENT_BEIJING_TIME]",
      "[RESPONSE_LENGTH]",
      "[HUMANIZER_STYLE]",
      "[RELEVANT_OWNER_MEMORY]",
      "[CONVERSATION_SUMMARY]",
    ].map((marker) =>
      contents.findIndex((content) => content.startsWith(marker)),
    );
    expect(indexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: "我今天还是有点焦虑",
    });
    expect(result.learnFromResponse).toBe(true);
  });

  it("asks Persona Bot to use about half the usual wording while adapting to context", () => {
    const result = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: [],
      summary: null,
      recentMessages: [],
      currentMessage: "今天在干嘛呀",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: 100_000,
    });
    const joined = result.messages.map((message) => message.content).join("\n");

    expect(joined).toContain("[RESPONSE_LENGTH]");
    expect(joined).toContain("约一半篇幅");
    expect(joined).toContain("简单消息优先一两句");
    expect(joined).toContain("安慰、重要解释或需要细节时可以适当增加");
    expect(joined).toContain("[HUMANIZER_STYLE]");
    expect(joined).toContain("去掉AI腔和说明书腔");
    expect(joined).toContain("不要用模板化开头");
    expect(joined).toContain("🌚 仅低频使用");
    expect(joined).toContain("同一轮回复不要重复使用");
  });

  it("drops oldest recent messages, then summary detail, then low-priority facts", () => {
    const generous = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: facts,
      summary: "S".repeat(1_000),
      recentMessages: [
        { role: "user", content: `old-${"x".repeat(500)}` },
        { role: "assistant", content: `new-${"y".repeat(500)}` },
      ],
      currentMessage: "current",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: 100_000,
    });
    const hardSize = generous.hardLayerChars;

    const withoutOldest = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: facts,
      summary: "S".repeat(1_000),
      recentMessages: [
        { role: "user", content: `old-${"x".repeat(500)}` },
        { role: "assistant", content: `new-${"y".repeat(500)}` },
      ],
      currentMessage: "current",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: hardSize + 1_850,
    });
    expect(withoutOldest.messages.some((item) => item.content.startsWith("old-"))).toBe(
      false,
    );
    expect(withoutOldest.messages.some((item) => item.content.startsWith("new-"))).toBe(
      true,
    );

    const pressured = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: facts,
      summary: "S".repeat(1_000),
      recentMessages: [
        { role: "user", content: `old-${"x".repeat(500)}` },
        { role: "assistant", content: `new-${"y".repeat(500)}` },
      ],
      currentMessage: "current",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: hardSize + 250,
    });
    const joined = pressured.messages.map((item) => item.content).join("\n");
    expect(joined).not.toContain("old-");
    expect(joined).not.toContain("new-");
    expect(joined).not.toContain("一条低优先级猜测");
    expect(pressured.summaryTruncated).toBe(true);
    expect(joined).toContain("[SAFETY_AND_REALITY]");
    expect(joined).toContain("[PERSONA]");
    expect(pressured.messages.at(-1)?.content).toBe("current");
  });

  it("never drops hard layers even when the requested budget is smaller", () => {
    const result = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: [],
      summary: null,
      recentMessages: [],
      currentMessage: "必须保留的当前消息",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: 10,
    });

    expect(result.totalChars).toBeGreaterThan(10);
    expect(result.messages).toHaveLength(9);
    expect(result.messages.at(-1)?.content).toBe("必须保留的当前消息");
  });
});

describe("/ask prompt isolation", () => {
  it("is explicitly non-learning and contains no Persona Bot persona claims", () => {
    const result = buildAskPrompt({
      question: "解释一下麦克斯韦方程组",
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
    });
    const joined = result.messages.map((message) => message.content).join("\n");

    expect(result.learnFromResponse).toBe(false);
    expect(result.mode).toBe("ask");
    expect(joined).toContain("[ASK_MODE_NON_LEARNING]");
    expect(joined).toContain(
      "[CURRENT_BEIJING_TIME]\n2025-06-15 23:06:50（北京时间，UTC+8）",
    );
    expect(joined).not.toContain("Persona Bot 与 OWNER");
    expect(joined).not.toContain("🌚");
  });
});
