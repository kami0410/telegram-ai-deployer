import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("disclaimer opens from confirmation and about views as plain text", async () => {
  const html = await readFile("app/renderer/index.html", "utf8");
  const script = await readFile("app/renderer/app.mjs", "utf8");
  assert.equal((html.match(/data-disclaimer-button/gu) ?? []).length, 2);
  assert.match(script, /noticeText"\)\.textContent\s*=\s*await api\.readDisclaimer/u);
  assert.doesNotMatch(script, /innerHTML/u);
});

test("resume flow is explicit and requires fresh secret entry", async () => {
  const script = await readFile("app/renderer/app.mjs", "utf8");
  assert.match(script, /resumeMode/u);
  assert.match(script, /submit\(resumeMode\)/u);
  assert.match(script, /showStep\(3\)/u);
});
