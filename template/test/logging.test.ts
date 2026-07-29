import { afterEach, expect, it, vi } from "vitest";
import { safeLog } from "../src/logging";

afterEach(() => vi.restoreAllMocks());

it("serializes only explicitly allowlisted fields", () => {
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    output.push(String(value));
  });

  const unsafeEvent = {
    eventHash: "event-123",
    stage: "telegram_send",
    durationMs: 12,
    httpStatus: 200,
    errorCode: null,
    inputTokens: 10,
    outputTokens: 20,
    chunkCount: 2,
    personaHash: "persona-456",
    telegramToken: "123456:secret-token",
    deepseekKey: "sk-secret-value",
    recoveryKey: "YR-AAAA-BBBB-CCCC-DDDD",
    message: "private chat text",
    prompt: "private system prompt",
  };

  safeLog(unsafeEvent);

  expect(output).toHaveLength(1);
  expect(JSON.parse(output[0] ?? "{}")).toEqual({
    eventHash: "event-123",
    stage: "telegram_send",
    durationMs: 12,
    httpStatus: 200,
    errorCode: null,
    inputTokens: 10,
    outputTokens: 20,
    chunkCount: 2,
    personaHash: "persona-456",
  });
  expect(output[0]).not.toContain("secret");
  expect(output[0]).not.toContain("private");
  expect(output[0]).not.toContain("YR-AAAA");
});
