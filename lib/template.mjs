import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRECTORIES = new Set(["node_modules", "out", "dist", ".wrangler", ".git"]);

function copyFilter(source) {
  return !source.split(/[\\/]/u).some((part) => SKIP_DIRECTORIES.has(part));
}

export function renderImportedPrompt(prompt) {
  return [
    "// Generated locally. Keep this file private and out of Git.",
    "export const IMPORTED_PERSONA_PROMPT = " + JSON.stringify(prompt) + ";",
    "",
  ].join("\n");
}

export async function generateProject({ templateRoot, outputDir, personaText = "" }) {
  try {
    if ((await readdir(outputDir)).length > 0) throw new Error("Output directory must be empty for a fresh deployment");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(outputDir, { recursive: true });
  await cp(templateRoot, outputDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: copyFilter,
  });
  const personaFile = path.join(outputDir, "src", "persona", "imported-prompt.ts");
  await mkdir(path.dirname(personaFile), { recursive: true });
  await writeFile(personaFile, renderImportedPrompt(personaText), "utf8");
  const ignorePath = path.join(outputDir, ".gitignore");
  let ignore = "";
  try {
    ignore = await readFile(ignorePath, "utf8");
  } catch {}
  if (!ignore.includes("src/persona/imported-prompt.ts")) {
    await writeFile(ignorePath, ignore + "\nsrc/persona/imported-prompt.ts\ndeployment-state.json\n", "utf8");
  }
}

export function renderWranglerConfig({
  names,
  databaseId,
  workerUrl,
  model,
  thinking,
}) {
  return JSON.stringify({
    $schema: "./node_modules/wrangler/config-schema.json",
    name: names.worker,
    main: "src/index.ts",
    compatibility_date: "2026-07-24",
    compatibility_flags: ["nodejs_compat"],
    observability: {
      enabled: true,
      logs: { head_sampling_rate: 1 },
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },
    vars: {
      DEEPSEEK_MODEL: model,
      DEEPSEEK_THINKING_MODE: thinking,
      MAX_OUTPUT_TOKENS: "100",
      DAILY_MESSAGE_LIMIT: "200",
      MEMORY_UPDATE_INTERVAL: "8",
      PUBLIC_BASE_URL: workerUrl,
    },
    d1_databases: [{
      binding: "DB",
      database_name: names.database,
      database_id: databaseId,
      migrations_dir: "migrations",
    }],
    ai: { binding: "AI" },
    vectorize: [{ binding: "MEMORY_INDEX", index_name: names.vectorize }],
    workflows: [{
      binding: "REMINDER_WORKFLOW",
      name: names.workflow,
      class_name: "ReminderWorkflow",
    }],
    queues: {
      producers: [{ binding: "MESSAGE_QUEUE", queue: names.queue }],
      consumers: [{
        queue: names.queue,
        max_batch_size: 1,
        max_batch_timeout: 1,
        max_retries: 3,
        dead_letter_queue: names.deadLetterQueue,
        max_concurrency: 1,
        retry_delay: 10,
      }],
    },
    triggers: { crons: ["*/15 * * * *"] },
  }, null, 2) + "\n";
}
