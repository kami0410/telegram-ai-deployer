import test from "node:test";
import assert from "node:assert/strict";
import {
  resourceNames,
  extractWorkerUrl,
  queueListContains,
  isWranglerAuthenticated,
  isWorkersDevSubdomainError,
  healthCheckFailureMessage,
} from "../lib/cloudflare.mjs";

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

test("detects wrangler authentication from whoami output text", () => {
  // wrangler whoami exits 0 even when unauthenticated, so callers must parse the output.
  assert.equal(isWranglerAuthenticated("You are not authenticated. Please run `wrangler login`."), false);
  assert.equal(isWranglerAuthenticated("You are logged in with an OAuth Token, associated with the email user@example.com."), true);
  assert.equal(isWranglerAuthenticated("You are logged in with an API Token."), true);
  assert.equal(isWranglerAuthenticated(""), false);
});

test("recognizes first-account workers.dev onboarding failures", () => {
  assert.equal(isWorkersDevSubdomainError("You need to register a workers.dev subdomain before publishing"), true);
  assert.equal(isWorkersDevSubdomainError("Unable to resolve D1 database ID"), false);
});

test("explains that a deployed Worker can be recovered after health-check failure", () => {
  assert.match(healthCheckFailureMessage("https://example.workers.dev", "fetch failed"), /Worker 已部署/u);
  assert.match(healthCheckFailureMessage("https://example.workers.dev", "fetch failed"), /恢复部署/u);
});

test("queue lookup compares an exact table cell instead of a substring", () => {
  const output = "name                         id\nmy-bot-main-old              abc\nmy-bot-dlq                   def\n";
  assert.equal(queueListContains(output, "my-bot-main"), false);
  assert.equal(queueListContains(output, "my-bot-dlq"), true);
});
