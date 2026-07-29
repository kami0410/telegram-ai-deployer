import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MODELS, normalizeModelSelection } from "../lib/models.mjs";

test("allows only current DeepSeek V4 models", () => {
  assert.deepEqual(MODELS.map(({ id }) => id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(normalizeModelSelection({ model: "deepseek-v4-flash", thinking: false }), {
    model: "deepseek-v4-flash",
    thinking: "disabled",
  });
  assert.throws(
    () => normalizeModelSelection({ model: "deepseek-chat", thinking: true }),
    /unsupported model/iu,
  );
});

test("bot template forwards the selected thinking mode", async () => {
  const deepseek = await readFile("template/src/deepseek.ts", "utf8");
  const queue = await readFile("template/src/queue.ts", "utf8");
  const testConfig = await readFile("template/wrangler.test.jsonc", "utf8");
  assert.match(deepseek, /thinking:\s*\{\s*type:/u);
  assert.match(queue, /DEEPSEEK_THINKING_MODE/u);
  assert.match(testConfig, /"DEEPSEEK_THINKING_MODE":\s*"disabled"/u);
});

test("requires an explicit boolean thinking choice", () => {
  assert.throws(
    () => normalizeModelSelection({ model: "deepseek-v4-pro", thinking: "yes" }),
    /thinking must be a boolean/iu,
  );
});
