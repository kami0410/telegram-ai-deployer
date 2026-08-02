import { describe, expect, it } from "vitest";
import {
  BUSY_MESSAGE,
  calculateBubbleGapSeconds,
  calculateBusyDurationSeconds,
  calculateInitialDelaySeconds,
  classifyMessageFlow,
  proactiveOutputTokenBudget,
  replyOutputTokenBudget,
  shouldEnterBusy,
  splitSemanticBubbles,
  type RandomSource,
} from "../src/queue";

function source(value: number): RandomSource {
  return { nextUint32: () => value };
}

describe("natural reply timing", () => {
  it("uses a small normal budget and expands only for serious flows", () => {
    expect(replyOutputTokenBudget(100, "normal")).toBe(100);
    expect(replyOutputTokenBudget(100, "comfort")).toBe(180);
    expect(replyOutputTokenBudget(100, "conflict")).toBe(180);
    expect(replyOutputTokenBudget(100, "safety")).toBe(220);
    expect(proactiveOutputTokenBudget(100)).toBe(70);
    expect(proactiveOutputTokenBudget(50)).toBe(50);
  });

  it("uses immediate safety, 20-60 second comfort, and 6-20 second normal delays", () => {
    expect(classifyMessageFlow("我想自杀")).toBe("safety");
    expect(calculateInitialDelaySeconds("safety", source(123))).toBe(0);

    expect(classifyMessageFlow("我最近好焦虑好难受")).toBe("comfort");
    expect(calculateInitialDelaySeconds("comfort", source(0))).toBe(20);
    expect(calculateInitialDelaySeconds("comfort", source(0xffff_ffff))).toBe(60);

    expect(classifyMessageFlow("今天吃什么呀")).toBe("normal");
    expect(calculateInitialDelaySeconds("normal", source(0))).toBe(6);
    expect(calculateInitialDelaySeconds("normal", source(0xffff_ffff))).toBe(20);
    expect(calculateBubbleGapSeconds(source(0))).toBe(2);
    expect(calculateBubbleGapSeconds(source(0xffff_ffff))).toBe(4);
  });

  it("keeps ordinary replies to at most three semantic bubbles", () => {
    const text =
      "第一句先听你说。第二句认真回应你。第三句再说一个角度。第四句给一个结论。第五句一起加油。第六句收尾。";
    const first = splitSemanticBubbles(text, "normal");
    const second = splitSemanticBubbles(text, "normal");

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(first.join("")).toBe(text);
  });

  it("allows serious replies up to four semantic bubbles", () => {
    const text =
      "先听你说。这个感受很正常。换个角度看看。你已经做得很好。再慢慢处理。最后一起加油。";

    const bubbles = splitSemanticBubbles(text, "comfort");

    expect(bubbles.length).toBeLessThanOrEqual(4);
    expect(bubbles.join("")).toBe(text);
  });

  it("preserves paragraph breaks without creating blank Telegram bubbles", () => {
    const text = "第一段。\n\n第二段。\n第三段。";
    const bubbles = splitSemanticBubbles(text);

    expect(bubbles.join("")).toBe(text);
    expect(bubbles.every((bubble) => bubble.trim().length > 0)).toBe(true);
  });

  it("keeps the last bubble short instead of dumping surplus sentences into it", () => {
    const text =
      "第一句先听你说。第二句认真回应你。第三句再说一个角度。第四句给一个结论。第五句一起加油。第六句收尾。";
    const bubbles = splitSemanticBubbles(text);

    expect(bubbles.join("")).toBe(text);
    expect(bubbles.at(-1)).toBe("第六句收尾。");
    expect(bubbles.at(-2)).toBe("第五句一起加油。");
  });

  it("turns paragraphs into bubbles when the budget allows", () => {
    const text = "先说第一件事。\n\n再说第二件事。\n\n最后说第三件事。";
    const bubbles = splitSemanticBubbles(text);

    expect(bubbles.join("")).toBe(text);
    expect(bubbles).toHaveLength(3);
    expect(bubbles[1]).toContain("第二件事");
    expect(bubbles[2]).toContain("第三件事");
  });

  it("merges the shortest paragraphs when there are more than the bubble cap", () => {
    const text =
      "一号段。\n\n二号段。\n\n中间这一段内容比较长，用来占住空间。\n\n四号段。\n\n五号段。";
    const bubbles = splitSemanticBubbles(text, "comfort");

    expect(bubbles.join("")).toBe(text);
    expect(bubbles.length).toBeLessThanOrEqual(4);
    expect(bubbles.at(-1)?.trim()).toBe("五号段。");
  });
});

describe("low-frequency busy mode", () => {
  it("only triggers for ordinary conversation and lasts one to three hours", () => {
    expect(shouldEnterBusy("normal", source(0), 1)).toBe(true);
    expect(shouldEnterBusy("normal", source(0xffff_ffff), 1)).toBe(false);
    for (const protectedFlow of ["comfort", "conflict", "safety"] as const) {
      expect(shouldEnterBusy(protectedFlow, source(0), 100)).toBe(false);
    }
    expect(calculateBusyDurationSeconds(source(0))).toBe(3_600);
    expect(calculateBusyDurationSeconds(source(0xffff_ffff))).toBe(10_800);
  });

  it("uses a generic phrase without fabricating an activity", () => {
    expect(BUSY_MESSAGE).toBe("我先去忙啦");
    expect(BUSY_MESSAGE).not.toMatch(/上课|图书馆|会计|朋友|开会/);
  });
});
