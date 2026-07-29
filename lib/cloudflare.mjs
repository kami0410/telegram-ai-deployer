import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRedactor } from "./redact.mjs";
import { runCommand } from "./runner.mjs";
import { generateProject, renderWranglerConfig } from "./template.mjs";

export function resourceNames(projectName) {
  return {
    worker: projectName,
    database: projectName + "-db",
    queue: projectName + "-main",
    deadLetterQueue: projectName + "-dlq",
    vectorize: projectName + "-memory",
    workflow: projectName + "-reminders",
  };
}

export function extractWorkerUrl(output) {
  const match = String(output).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/iu);
  if (match === null) throw new Error("Deployment output did not include a workers.dev URL");
  return match[0];
}

export function queueListContains(output, queueName) {
  return String(output).split(/\r?\n/u).some((line) => line.split(/[\s│]+/u).includes(queueName));
}

function parseJsonOutput(output) {
  const start = output.indexOf("[");
  const objectStart = output.indexOf("{");
  const first = start === -1 ? objectStart : objectStart === -1 ? start : Math.min(start, objectStart);
  if (first === -1) throw new Error("Wrangler did not return JSON");
  return JSON.parse(output.slice(first));
}

async function readPersona(input) {
  if (!input.personaPath) return "";
  const extension = path.extname(input.personaPath).toLowerCase();
  if (![".txt", ".md", ".json"].includes(extension)) throw new Error("Persona file must be txt, md, or json");
  const text = (await readFile(input.personaPath, "utf8")).replace(/^\uFEFF/u, "").trim();
  if (text.length > 100_000) throw new Error("Persona file exceeds 100000 characters");
  if (extension === ".json") JSON.parse(text);
  return text;
}

export function createDeploymentDependencies({
  appRoot,
  templateRoot,
  nodeExecutable,
  runtimeEntry,
  wranglerCli,
  emit,
  onOutput = () => {},
  fetcher = fetch,
  now = () => new Date().toISOString(),
}) {
  let webhookSecret = randomBytes(32).toString("base64url");
  let redactor = createRedactor([]);
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(runtimeEntry) || !path.isAbsolute(wranglerCli)) {
    throw new Error("Trusted deployment runtime paths are required");
  }
  const runtimeEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

  async function checked(executable, args, cwd, input) {
    const result = await runCommand(executable, args, { cwd, input, redact: redactor, onOutput, env: runtimeEnvironment });
    if (result.code !== 0) throw new Error(redactor(result.stderr || result.stdout || "Command failed"));
    return result.stdout;
  }

  const wrangler = (args, cwd, input) => checked(nodeExecutable, [runtimeEntry, wranglerCli, ...args], cwd, input);

  async function writeConfig(input, state, workerUrl = "https://example.invalid") {
    const names = resourceNames(input.projectName);
    const databaseId = state.resources.databaseId;
    if (typeof databaseId !== "string") throw new Error("D1 database ID is unavailable");
    await writeFile(path.join(input.outputDir, "wrangler.jsonc"), renderWranglerConfig({
      names,
      databaseId,
      workerUrl,
      model: input.model,
      thinking: input.thinking,
    }), "utf8");
  }

  async function runStep(step, { input, state }) {
    const names = resourceNames(input.projectName);
    redactor = createRedactor([
      input.telegramToken,
      input.deepseekKey,
      input.pairingCode,
      webhookSecret,
    ]);
    if (step === "environment") {
      await wrangler(["whoami"], appRoot);
      return {};
    }
    if (step === "template") {
      const personaText = await readPersona(input);
      await generateProject({ templateRoot, outputDir: input.outputDir, personaText });
      return {};
    }
    if (step === "d1") {
      let databases = parseJsonOutput(await wrangler(["d1", "list", "--json"], input.outputDir));
      let database = databases.find((item) => item.name === names.database);
      if (!database) {
        await wrangler(["d1", "create", names.database], input.outputDir);
        databases = parseJsonOutput(await wrangler(["d1", "list", "--json"], input.outputDir));
        database = databases.find((item) => item.name === names.database);
      }
      const databaseId = database?.uuid ?? database?.id;
      if (typeof databaseId !== "string") throw new Error("Unable to resolve D1 database ID");
      return { databaseId };
    }
    if (step === "queues") {
      const list = await wrangler(["queues", "list"], input.outputDir);
      if (!queueListContains(list, names.queue)) await wrangler(["queues", "create", names.queue], input.outputDir);
      if (!queueListContains(list, names.deadLetterQueue)) {
        await wrangler(["queues", "create", names.deadLetterQueue], input.outputDir);
      }
      return { resources: { queue: names.queue, deadLetterQueue: names.deadLetterQueue } };
    }
    if (step === "vectorize") {
      const indexes = parseJsonOutput(await wrangler(["vectorize", "list", "--json"], input.outputDir));
      if (!indexes.some((item) => item.name === names.vectorize)) {
        await wrangler(["vectorize", "create", names.vectorize, "--dimensions=1024", "--metric=cosine"], input.outputDir);
      }
      const metadataText = await wrangler(["vectorize", "list-metadata-index", names.vectorize, "--json"], input.outputDir);
      for (const [property, type] of [["owner_id", "number"], ["kind", "string"], ["category", "string"], ["occurred_at", "number"], ["active", "boolean"]]) {
        if (!metadataText.includes('"' + property + '"')) {
          await wrangler(["vectorize", "create-metadata-index", names.vectorize, "--propertyName=" + property, "--type=" + type], input.outputDir);
        }
      }
      return { resources: { vectorize: names.vectorize } };
    }
    if (step === "migration") {
      await writeConfig(input, state);
      await wrangler(["d1", "migrations", "apply", names.database, "--remote"], input.outputDir);
      return {};
    }
    if (step === "first-deploy") {
      await writeConfig(input, state);
      const output = await wrangler(["deploy", "--minify"], input.outputDir);
      return { workerUrl: extractWorkerUrl(output) };
    }
    if (step === "secrets") {
      const telegram = await fetcher("https://api.telegram.org/bot" + input.telegramToken + "/getMe").then((response) => response.json());
      if (!telegram.ok) throw new Error("Telegram token validation failed");
      const deepseek = await fetcher("https://api.deepseek.com/models", {
        headers: { authorization: "Bearer " + input.deepseekKey },
      });
      if (!deepseek.ok) throw new Error("DeepSeek key validation failed");
      await wrangler(["secret", "bulk"], input.outputDir, JSON.stringify({
        TELEGRAM_BOT_TOKEN: input.telegramToken,
        DEEPSEEK_API_KEY: input.deepseekKey,
        TELEGRAM_WEBHOOK_SECRET: webhookSecret,
        OWNER_PAIRING_CODE: input.pairingCode,
      }));
      return {};
    }
    if (step === "final-deploy") {
      await writeConfig(input, state, state.workerUrl);
      const output = await wrangler(["deploy", "--minify"], input.outputDir);
      return { workerUrl: extractWorkerUrl(output) };
    }
    if (step === "webhook") {
      const response = await fetcher("https://api.telegram.org/bot" + input.telegramToken + "/setWebhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: state.workerUrl + "/telegram/webhook",
          secret_token: webhookSecret,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: false,
        }),
      }).then((value) => value.json());
      if (!response.ok) throw new Error("Telegram webhook registration failed");
      return {};
    }
    if (step === "health") {
      const response = await fetcher(state.workerUrl + "/health");
      if (!response.ok) throw new Error("Worker health check failed");
      return {};
    }
    throw new Error("Unknown deployment step");
  }

  return {
    runStep,
    emit,
    now,
    readState: async (outputDir) => {
      try {
        return JSON.parse(await readFile(path.join(outputDir, "deployment-state.json"), "utf8"));
      } catch {
        return null;
      }
    },
    writeState: async (state) => {
      await writeFile(path.join(state.outputDir, "deployment-state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
    },
    rotateWebhookSecret: () => {
      webhookSecret = randomBytes(32).toString("base64url");
    },
  };
}
