import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function textFiles(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ["node_modules", "out", "dist", ".wrangler"].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await textFiles(fullPath));
    else if (/\.(?:ts|js|mjs|json|jsonc|md|sql|txt)$/iu.test(entry.name)) output.push(fullPath);
  }
  return output;
}

test("generic template contains no deployment identity or private persona material", async () => {
  const files = await textFiles("template");
  assert.ok(files.length >= 20, "expected a complete bot template");
  const forbidden = [
    /https?:\/\/[^\s"']+\.workers\.dev/iu,
    /\b(?!00000000-0000-0000-0000-000000000000)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/u,
    /(?:sk-|tvly-)[A-Za-z0-9_-]{16,}/u,
    /[A-Z]:\\Users\\[^\\\s]+/iu,
    /chat[_ -]?export|private[_ -]?persona/iu,
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${path.relative("template", file)} matched ${pattern}`);
    }
  }
});
