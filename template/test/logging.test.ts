import { afterEach, expect, it, vi } from "vitest";
import { safeLog } from "../src/logging";
import { processQueueBatch } from "../src/queue";

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

it("records an allowlisted event when an invalid queue message is discarded", async () => {
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value?: unknown) => output.push(String(value)));
  const ack = vi.fn();
  await processQueueBatch({
    messages: [{ body: { type: "unknown" }, ack, retry: vi.fn() }],
  } as unknown as MessageBatch<unknown>, {} as Env);

  expect(ack).toHaveBeenCalledOnce();
  expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
    stage: "queue_invalid",
    errorCode: "invalid_queue_job",
  });
  expect(output[0]).not.toContain("unknown");
});
