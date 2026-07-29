import test from "node:test";
import assert from "node:assert/strict";
import { resourceNames, extractWorkerUrl } from "../lib/cloudflare.mjs";

test("derives isolated Cloudflare resource names", () => {
  assert.deepEqual(resourceNames("example-bot"), {
    worker: "example-bot",
    database: "example-bot-db",
    queue: "example-bot-main",
    deadLetterQueue: "example-bot-dlq",
    vectorize: "example-bot-memory",
    workflow: "example-bot-reminders",
  });
});

test("extracts only a workers.dev deployment URL", () => {
  assert.equal(
    extractWorkerUrl("Uploaded\nhttps://example-bot.example-account.workers.dev\n"),
    "https://example-bot.example-account.workers.dev",
  );
  assert.throws(() => extractWorkerUrl("https://example.invalid"), /workers.dev/iu);
});
