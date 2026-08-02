import test from "node:test";
import assert from "node:assert/strict";
import { validateDeploymentInput } from "../lib/validation.mjs";

const input = {
  projectName: "Example Bot",
  outputDir: "D:\\Bots\\example-bot",
  telegramToken: "example-telegram-token-that-is-not-valid",
  deepseekKey: "example-deepseek-key-that-is-not-valid",
  pairingCode: "example-1234",
  model: "deepseek-v4-flash",
  thinking: false,
  disclaimerAccepted: true,
};

test("normalizes a safe deployment input", () => {
  const result = validateDeploymentInput(input);
  assert.equal(result.projectName, "example-bot");
  assert.equal(result.model, "deepseek-v4-flash");
});

test("requires disclaimer acceptance and a whitelisted model", () => {
  assert.throws(
    () => validateDeploymentInput({ ...input, disclaimerAccepted: false }),
    /disclaimer/iu,
  );
  assert.throws(
    () => validateDeploymentInput({ ...input, model: "deepseek-chat" }),
    /unsupported model/iu,
  );
});

test("rejects output paths that are not absolute", () => {
  assert.throws(
    () => validateDeploymentInput({ ...input, outputDir: "relative\\path" }),
    /absolute/iu,
  );
});
