import { describe, expect, it } from "vitest";
import {
  classifyDialogue,
  guidanceForDialogue,
  shouldChallengeAgreement,
} from "../src/dialogue-guidance";

describe("dialogue guidance", () => {
  it.each([
    ["我今天终于把作业写完了哈哈哈哈", "celebrate"],
    ["我最近一想到考试就很焦虑", "anxiety"],
    ["你觉得我应该直接跟她说吗", "advice"],
    ["你先听我讲完嘛", "listen"],
    ["我跟你说她们班那个八卦", "gossip"],
    ["她这样真的气死我了", "conflict"],
    ["你是不是有一点喜欢我呀", "intimacy"],
    ["刚吃了一个很好吃的小蛋糕", "share"],
    ["干啥呢最近", "normal"],
  ] as const)("classifies %s as %s", (text, expected) => {
    expect(classifyDialogue(text).intent).toBe(expected);
  });

  it("falls back conservatively without inventing a need for advice", () => {
    expect(classifyDialogue("嗯嗯嗯")).toEqual({
      intent: "normal",
      stage: "respond",
      confidence: "low",
    });
  });

  it("maps distress to validation before advice", () => {
    const guidance = guidanceForDialogue(classifyDialogue("我最近压力好大想哭"));
    expect(guidance).toContain("先理解和回应情绪");
    expect(guidance).toContain("不要立刻给方案");
  });

  it("separates validating feelings from endorsing disputed facts", () => {
    expect(shouldChallengeAgreement("她肯定就是故意针对我")).toBe(true);
    expect(shouldChallengeAgreement("我今天真的很难过")).toBe(false);
    expect(guidanceForDialogue(classifyDialogue("她肯定就是故意针对我")))
      .toContain("认可感受不等于确认推测");
  });
});
