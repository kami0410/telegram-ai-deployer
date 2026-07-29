import { describe, expect, it } from "vitest";
import {
  BUSY_MESSAGE,
  calculateBubbleGapSeconds,
  calculateBusyDurationSeconds,
  calculateInitialDelaySeconds,
  classifyMessageFlow,
  shouldEnterBusy,
  splitSemanticBubbles,
  type RandomSource,
} from "../src/queue";

function source(value: number): RandomSource {
  return { nextUint32: () => value };
}

describe("natural reply timing", () => {
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

  it("splits ordinary prose deterministically into two to five semantic bubbles", () => {
    const text =
      "第一句先听你说。第二句认真回应你。第三句再说一个角度。第四句给一个结论。第五句一起加油。第六句收尾。";
    const first = splitSemanticBubbles(text);
    const second = splitSemanticBubbles(text);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.length).toBeLessThanOrEqual(5);
    expect(first.join("")).toBe(text);
  });

  it("preserves paragraph breaks without creating blank Telegram bubbles", () => {
    const text = "第一段。\n\n第二段。\n第三段。";
    const bubbles = splitSemanticBubbles(text);

    expect(bubbles.join("")).toBe(text);
    expect(bubbles.every((bubble) => bubble.trim().length > 0)).toBe(true);
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
