import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consumeDeploymentForm, createInitialWizardState } from "../app/renderer/form-state.mjs";

test("wizard exposes five local-only steps and the approved model choices", async () => {
  const html = await readFile("app/renderer/index.html", "utf8");
  assert.equal((html.match(/<section\b/gu) ?? []).length, 5);
  assert.match(html, /value="deepseek-v4-flash"[^>]*checked/u);
  assert.equal((html.match(/name="model"/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.match(html, /aria-live="polite"/u);
});

test("all three secrets are password controls and disclaimer gates deployment", async () => {
  const html = await readFile("app/renderer/index.html", "utf8");
  assert.equal((html.match(/type="password"/gu) ?? []).length, 3);
  const state = createInitialWizardState();
  assert.equal(state.acceptedDisclaimer, false);
  assert.equal(state.canDeploy, false);
});

test("consuming a form clears secret controls synchronously", () => {
  const controls = {
    telegramToken: { value: "telegram-secret" },
    deepseekKey: { value: "deepseek-secret" },
    pairingCode: { value: "pairing-secret" },
  };
  const payload = consumeDeploymentForm(controls, {
    projectName: "demo-bot",
    outputDir: "C:\\Bots",
    model: "deepseek-v4-flash",
    thinking: false,
    acceptedDisclaimer: true,
  });
  assert.equal(payload.telegramToken, "telegram-secret");
  assert.equal(payload.deepseekKey, "deepseek-secret");
  assert.equal(payload.pairingCode, "pairing-secret");
  assert.deepEqual(Object.values(controls).map((control) => control.value), ["", "", ""]);
});
