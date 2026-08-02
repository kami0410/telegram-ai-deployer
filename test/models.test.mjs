import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MODELS, normalizeModelSelection } from "../lib/models.mjs";

test("allows only current DeepSeek V4 models", () => {
  assert.deepEqual(MODELS.map(({ id }) => id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(normalizeModelSelection({ model: "deepseek-v4-flash" }), {
    model: "deepseek-v4-flash",
  });
  assert.throws(
    () => normalizeModelSelection({ model: "deepseek-chat" }),
    /unsupported model/iu,
  );
});

test("bot template keeps /ask thinking enabled and ignores the removed toggle", async () => {
  const deepseek = await readFile("template/src/deepseek.ts", "utf8");
  const queue = await readFile("template/src/queue.ts", "utf8");
  assert.match(deepseek, /thinking:\s*\{\s*type:/u);
  assert.doesNotMatch(queue, /DEEPSEEK_THINKING_MODE/u);
  assert.match(queue, /thinking: "enabled"/u);
});
