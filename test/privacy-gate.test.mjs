import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("privacy gate covers worktree, history, generated output, and package payload", async () => {
  const script = await readFile("scripts/privacy-scan.ps1", "utf8");
  for (const marker of ["Assert-GitScopeClean", "git rev-list", "generate-privacy-fixture.mjs", "app.asar", "dist", "Remove-Item"]) {
    assert.match(script, new RegExp(marker, "u"));
  }
  assert.match(script, /tvly-/u);
  assert.match(script, /workers/u);
});

test("privacy fixture generator uses only a declared public marker", async () => {
  const helper = await readFile("scripts/generate-privacy-fixture.mjs", "utf8");
  assert.match(helper, /PUBLIC TEST PERSONA/u);
  assert.doesNotMatch(helper, /process\.env/u);
});
