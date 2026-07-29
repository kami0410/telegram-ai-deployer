import test from "node:test";
import assert from "node:assert/strict";
import { resourceNames, extractWorkerUrl, queueListContains } from "../lib/cloudflare.mjs";

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

test("queue lookup compares an exact table cell instead of a substring", () => {
  const output = "name                         id\nmy-bot-main-old              abc\nmy-bot-dlq                   def\n";
  assert.equal(queueListContains(output, "my-bot-main"), false);
  assert.equal(queueListContains(output, "my-bot-dlq"), true);
});
