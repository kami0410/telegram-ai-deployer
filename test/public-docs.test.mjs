import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public docs expose disclaimers and contain no deployment identity", async () => {
  for (const file of ["README.md", "README_ZH.md"]) {
    const text = await readFile(file, "utf8");
    assert.match(text, /DISCLAIMER/u);
    assert.doesNotMatch(text, /https?:\/\/[^\s]+\.workers\.dev|account[_ -]?id/iu);
  }

  for (const file of ["DISCLAIMER.md", "DISCLAIMER_ZH.md"]) {
    const text = (await readFile(file, "utf8")).toLowerCase();
    for (const concept of ["cloudflare", "telegram", "deepseek", "ai"]) {
      assert.match(text, new RegExp(concept, "u"));
    }
    assert.match(text, file.endsWith("_ZH.md") ? /隐私/u : /privacy/u);
  }
});
