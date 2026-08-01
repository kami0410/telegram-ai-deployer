import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const requiredMigrations = [
  "0008_relationship_state.sql",
  "0009_reply_feedback.sql",
  "0010_memory_controls.sql",
  "0011_chat_preferences.sql",
  "0012_memory_time_layers.sql",
  "0013_open_thread_followups.sql",
  "0014_interaction_preferences.sql",
  "0015_realism_features.sql",
];

test("generic template includes the complete relationship and realism feature set", async () => {
  for (const migration of requiredMigrations) await access(`template/migrations/${migration}`);
  for (const source of [
    "dialogue-guidance.ts",
    "persona-reply.ts",
    "storage/chat-preferences-repository.ts",
    "storage/memory-control-repository.ts",
    "storage/realism-repository.ts",
    "storage/relationship-repository.ts",
    "storage/reply-feedback-repository.ts",
    "storage/time-memory-repository.ts",
  ]) await access(`template/src/${source}`);

  const commands = await readFile("template/src/commands.ts", "utf8");
  assert.match(commands, /\/temp/u);
  assert.match(commands, /\/redo/u);
  const appApi = await readFile("template/src/app-api.ts", "utf8");
  assert.match(appApi, /relationship-timeline/u);
});

test("ported template uses generic persona terminology", async () => {
  const files = [
    "template/src/prompt.ts",
    "template/src/queue.ts",
    "template/src/commands.ts",
    "template/src/app-page.ts",
    "template/src/webhook.ts",
    "template/src/persona-reply.ts",
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.match(combined, /mode:\s*["']persona["']/u);
  assert.match(combined, /buildPersonaPrompt/u);
  assert.match(combined, /sanitizePersonaReply/u);
});
