import { describe, expect, it } from "vitest";
import { weeklyReviewWindow } from "../src/scheduled";

describe("weekly review window", () => {
  it("opens at Sunday 21:00 Beijing time with a stable seven-day period", () => {
    const due = Date.UTC(2026, 7, 2, 13, 0, 0) / 1_000;
    expect(weeklyReviewWindow(due)).toEqual({
      weekKey: "2026-08-02",
      periodStart: due - 7 * 86_400,
      periodEnd: due,
    });
    expect(weeklyReviewWindow(due + 3_599)).toEqual({
      weekKey: "2026-08-02",
      periodStart: due - 7 * 86_400,
      periodEnd: due,
    });
  });

  it("does not open before Sunday 21:00 or on another day", () => {
    expect(weeklyReviewWindow(Date.UTC(2026, 7, 2, 12, 59, 0) / 1_000)).toBeNull();
    expect(weeklyReviewWindow(Date.UTC(2026, 7, 1, 13, 0, 0) / 1_000)).toBeNull();
  });
});
