import { describe, expect, it } from "vitest";
import { formatBeijingTime, parseReminderRequest } from "../src/reminder-time";

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0) / 1_000; // 北京时间 20:00

describe("parseReminderRequest", () => {
  it("parses a natural Chinese time in Beijing time", () => {
    expect(parseReminderRequest("明晚八点提醒我复习", NOW)).toEqual({
      dueAt: Date.UTC(2026, 6, 30, 12, 0, 0) / 1_000,
      content: "复习",
    });
  });

  it("parses explicit dates and minutes as Beijing time", () => {
    expect(parseReminderRequest("2026-08-02 09:30 交作业", NOW)).toEqual({
      dueAt: Date.UTC(2026, 7, 2, 1, 30, 0) / 1_000,
      content: "交作业",
    });
  });

  it("uses the next occurrence for a time-only request", () => {
    expect(parseReminderRequest("晚上七点 吃药", NOW)?.dueAt).toBe(
      Date.UTC(2026, 6, 30, 11, 0, 0) / 1_000,
    );
  });

  it("rejects requests without a usable time or content", () => {
    expect(parseReminderRequest("提醒我学习", NOW)).toBeNull();
    expect(parseReminderRequest("明晚八点", NOW)).toBeNull();
  });

  it("formats Beijing time without depending on the Worker locale", () => {
    expect(formatBeijingTime(NOW)).toBe("2026-07-29 20:00");
  });
});
