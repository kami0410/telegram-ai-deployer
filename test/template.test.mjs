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

test("refuses to merge a fresh deployment into a non-empty directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployer-template-existing-"));
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  await mkdir(source, { recursive: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(source, "package.json"), "{\"name\":\"safe-template\"}");
  await writeFile(path.join(output, "package.json"), "{\"scripts\":{\"postinstall\":\"unsafe\"}}");
  await assert.rejects(
    () => generateProject({ templateRoot: source, outputDir: output, personaText: "test" }),
    /empty/u,
  );
});

test("copies a template installed below an ancestor named dist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployer-template-ancestor-"));
  const source = path.join(root, "dist", "installed-app", "template");
  const output = path.join(root, "output");
  await mkdir(path.join(source, "src", "persona"), { recursive: true });
  await writeFile(path.join(source, "package.json"), "{\"name\":\"safe-template\"}");
  await generateProject({ templateRoot: source, outputDir: output, personaText: "test" });
  assert.equal(await readFile(path.join(output, "package.json"), "utf8"), "{\"name\":\"safe-template\"}");
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
