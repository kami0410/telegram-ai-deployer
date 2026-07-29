import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consumeDeploymentForm, createInitialWizardState, validateWizardValues } from "../app/renderer/form-state.mjs";

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
  assert.match(html, /\/pair &lt;你填写的配对\/迁移密钥&gt;/u);
});

test("successful deployment explains the required first-time pairing command", async () => {
  const script = await readFile("app/renderer/app.mjs", "utf8");
  assert.match(script, /首次使用请发送 \/pair <配对\/迁移密钥>/u);
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

test("configuration validation requires an empty-project path and all secrets", () => {
  const valid = {
    projectName: "demo-bot", outputDir: "C:\\Bots\\demo-bot", model: "deepseek-v4-flash",
    telegramToken: "1".repeat(20), deepseekKey: "k".repeat(10), pairingCode: "pair-code",
  };
  assert.equal(validateWizardValues(valid), "");
  assert.match(validateWizardValues({ ...valid, outputDir: "Bots" }), /absolute/u);
  assert.match(validateWizardValues({ ...valid, telegramToken: "" }), /required/u);
});
