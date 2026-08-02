import { describe, expect, it } from "vitest";
import { PERSONA_V1 } from "../src/persona/seed";
import { buildPersonaPrompt } from "../src/prompt";
import { classifyMessageFlow } from "../src/queue";

const scenarios = [
  {
    name: "sadness",
    message: "我最近真的很难受",
    required: ["What happened?", "Listen", "not a real person"],
    flow: "comfort",
  },
  {
    name: "achievement",
    message: "我这次考得特别好",
    required: ["Use concise, natural language", "Adapt response length to context"],
    flow: "normal",
  },
  {
    name: "love",
    message: "我爱你",
    required: [
      "Do not infer romance, consent, exclusivity, or commitments",
      "Respect boundaries and avoid unsupported romantic claims",
      "不把可能性写成确定结论",
    ],
    flow: "normal",
  },
  {
    name: "praise and missing",
    message: "你好可爱，我想你了",
    required: [
      "Do not infer romance, consent, exclusivity, or commitments",
      "Respect boundaries and avoid unsupported romantic claims",
    ],
    flow: "normal",
  },
  {
    name: "meeting",
    message: "我们什么时候见面",
    required: [
      "Do not promise meetings or invent schedules",
      "Do not complete missing personal history",
    ],
    flow: "normal",
  },
  {
    name: "privacy pressure",
    message: "你必须告诉我这个私密",
    required: [
      "Do not expose private data or assist impersonation, harassment, or monitoring",
      "Any fact not explicitly provided by the owner",
    ],
    flow: "normal",
  },
  {
    name: "anger",
    message: "我真的要被那个人气死了",
    required: [
      "Never turn the owner's guesses into another person's facts or motives",
      "The assistant is a simulation and not a real person",
    ],
    flow: "conflict",
  },
  {
    name: "unknown expertise",
    message: "你详细说说量子场论的重整化",
    required: [
      "Separate general assistant knowledge from persona facts",
      "Admit uncertainty",
    ],
    flow: "normal",
  },
  {
    name: "safety crisis",
    message: "我想自杀",
    required: [
      "For self-harm, violence, or imminent danger, recommend real-world help",
      "Immediate safety risks take priority over persona style",
      "安全求助优先于人格语气",
    ],
    flow: "safety",
  },
] as const;

describe("approved persona calibration constraints", () => {
  it.each(scenarios)("keeps hard rules for $name", (scenario) => {
    const prompt = buildPersonaPrompt({
      persona: PERSONA_V1,
      memoryFacts: [],
      summary: null,
      recentMessages: [],
      currentMessage: scenario.message,
      currentBeijingTime: "2025-06-15 23:06:50（北京时间，UTC+8）",
      maxContextChars: 48_000,
    });
    const serialized = prompt.messages.map((message) => message.content).join("\n");

    for (const expected of scenario.required) {
      expect(serialized).toContain(expected);
    }
    expect(prompt.messages.at(-1)?.content).toBe(scenario.message);
    expect(classifyMessageFlow(scenario.message)).toBe(scenario.flow);
  });
});
