import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateProject, renderWranglerConfig } from "../lib/template.mjs";

test("generates a private project without copying dependency or build directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployer-template-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(path.join(source, "src", "persona"), { recursive: true });
  await mkdir(path.join(source, "node_modules"), { recursive: true });
  await writeFile(path.join(source, "package.json"), "{\"name\":\"example\"}");
  await writeFile(path.join(source, "src", "persona", "imported-prompt.ts"), "old");
  await writeFile(path.join(source, "node_modules", "secret.txt"), "not copied");
  await writeFile(path.join(source, ".gitignore"), "node_modules/\n");

  await generateProject({
    templateRoot: source,
    outputDir: output,
    personaText: "calm and concise",
  });
  assert.match(await readFile(path.join(output, "src", "persona", "imported-prompt.ts"), "utf8"), /calm and concise/u);
  await assert.rejects(() => readFile(path.join(output, "node_modules", "secret.txt")));
  assert.match(await readFile(path.join(output, ".gitignore"), "utf8"), /imported-prompt\.ts/u);
});

test("renders selected model and thinking mode without secrets", () => {
  const config = renderWranglerConfig({
    names: {
      worker: "example-bot",
      database: "example-bot-db",
      queue: "example-bot-main",
      deadLetterQueue: "example-bot-dlq",
      vectorize: "example-bot-memory",
      workflow: "example-bot-reminders",
    },
    databaseId: "00000000-0000-0000-0000-000000000000",
    workerUrl: "https://example.invalid",
    model: "deepseek-v4-flash",
    thinking: "disabled",
  });
  assert.match(config, /"DEEPSEEK_MODEL": "deepseek-v4-flash"/u);
  assert.match(config, /"DEEPSEEK_THINKING_MODE": "disabled"/u);
  assert.doesNotMatch(config, /TELEGRAM_BOT_TOKEN|DEEPSEEK_API_KEY/u);
});
