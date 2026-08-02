import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRECTORIES = new Set(["node_modules", "out", "dist", ".wrangler", ".git"]);

function createCopyFilter(templateRoot) {
  const resolvedTemplateRoot = path.resolve(templateRoot);
  return (source) => {
    const relativeSource = path.relative(resolvedTemplateRoot, path.resolve(source));
    if (relativeSource === "") return true;
    return !relativeSource.split(/[\\/]/u).some((part) => SKIP_DIRECTORIES.has(part));
  };
}

export function renderImportedPrompt(prompt) {
  return [
    "// Generated locally. Keep this file private and out of Git.",
    "export const IMPORTED_PERSONA_PROMPT = " + JSON.stringify(prompt) + ";",
    "",
  ].join("\n");
}

export function parentDirectoryToCreate(outputDir, pathApi = path) {
  const parent = pathApi.dirname(pathApi.resolve(outputDir));
  return parent === pathApi.parse(parent).root ? null : parent;
}

export async function generateProject({ templateRoot, outputDir, personaText = "" }) {
  const resolvedOutput = path.resolve(outputDir);
  const outputName = path.basename(resolvedOutput);
  if (!outputName) throw new Error("Output directory must name a project folder");
  let outputExists = false;
  try {
    const outputEntries = await readdir(resolvedOutput);
    outputExists = true;
    if (outputEntries.length > 0) throw new Error("Output directory must be empty for a fresh deployment");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    outputExists = false;
  }
  const parent = path.dirname(resolvedOutput);
  const staging = path.join(parent, `.${outputName}.staging-${randomUUID()}`);
  const parentToCreate = parentDirectoryToCreate(resolvedOutput);
  if (parentToCreate !== null) await mkdir(parentToCreate, { recursive: true });
  try {
    await cp(templateRoot, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: createCopyFilter(templateRoot),
    });
    const personaFile = path.join(staging, "src", "persona", "imported-prompt.ts");
    await mkdir(path.dirname(personaFile), { recursive: true });
    await writeFile(personaFile, renderImportedPrompt(personaText), "utf8");
    const ignorePath = path.join(staging, ".gitignore");
    let ignore = "";
    try { ignore = await readFile(ignorePath, "utf8"); } catch {}
    if (!ignore.includes("src/persona/imported-prompt.ts")) {
      await writeFile(ignorePath, ignore + "\nsrc/persona/imported-prompt.ts\ndeployment-state.json\n", "utf8");
    }
    if (outputExists) await rmdir(resolvedOutput);
    await rename(staging, resolvedOutput);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export function renderWranglerConfig({
  names,
  databaseId,
  workerUrl,
  model,
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
