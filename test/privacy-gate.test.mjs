import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { detectSensitive } from "../scripts/privacy-rules.mjs";

test("privacy gate covers worktree, history, generated output, and package payload", async () => {
  const script = await readFile("scripts/privacy-scan.ps1", "utf8");
  for (const marker of ["Assert-GitScopeClean", "Assert-GitStructuredClean", "git rev-list", "generate-privacy-fixture.mjs", "app.asar", "dist", "Remove-Item"]) {
    assert.match(script, new RegExp(marker, "u"));
  }
  assert.match(script, /tvly-/u);
  assert.match(script, /workers/u);
});

test("privacy rules detect each prohibited class without returning matched values", () => {
  const fixtures = [
    ["private-persona-marker", "Yuan"],
    ["telegram-token", "123456789:" + "A".repeat(32)],
    ["provider-key", "tvly-" + "B".repeat(20)],
    ["production-worker-url", "https://private-name.account.workers.dev"],
    ["non-placeholder-uuid", "123e4567-e89b-42d3-a456-426614174000"],
    ["windows-user-path", "C:\\Users\\RealPerson\\secret.txt"],
    ["non-example-email", "real.person@private-domain.org"],
    ["secret-assignment", 'API_KEY="' + "C".repeat(20) + '"'],
  ];
  for (const [rule, fixture] of fixtures) assert.ok(detectSensitive(fixture).includes(rule), rule);
  assert.ok(detectSensitive("{}", "chat_export.json").includes("chat-export"));
  assert.equal(detectSensitive('API_KEY="test-only-deepseek-key"').includes("secret-assignment"), false);
  assert.ok(detectSensitive('API_KEY="realcredentialvalue123"').includes("secret-assignment"));
  assert.deepEqual(detectSensitive("noreply@example.invalid 00000000-0000-0000-0000-000000000000"), []);
});

test("privacy fixture generator uses only a declared public marker", async () => {
  const helper = await readFile("scripts/generate-privacy-fixture.mjs", "utf8");
  assert.match(helper, /PUBLIC TEST PERSONA/u);
  assert.doesNotMatch(helper, /process\.env/u);
});
