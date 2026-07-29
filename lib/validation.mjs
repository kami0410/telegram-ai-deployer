import path from "node:path";
import { normalizeModelSelection } from "./models.mjs";

function requireText(value, label, minimum = 1, maximum = 10_000) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(label + " is invalid");
  }
  return value;
}

export function normalizeProjectName(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!/^[a-z][a-z0-9-]{1,39}$/u.test(normalized)) {
    throw new Error("Project name must begin with a letter and contain 2-40 safe characters");
  }
  return normalized;
}

export function validateDeploymentInput(input) {
  if (input === null || typeof input !== "object") throw new Error("Deployment input is required");
  if (input.disclaimerAccepted !== true) throw new Error("Disclaimer acceptance is required");
  const model = normalizeModelSelection({ model: input.model, thinking: input.thinking });
  const outputDir = requireText(input.outputDir, "Output directory", 3, 1_000);
  if (!path.isAbsolute(outputDir) && !path.win32.isAbsolute(outputDir)) {
    throw new Error("Output directory must be absolute");
  }
  return {
    projectName: normalizeProjectName(input.projectName),
    outputDir: path.resolve(outputDir),
    telegramToken: requireText(input.telegramToken, "Telegram token", 20, 500),
    deepseekKey: requireText(input.deepseekKey, "DeepSeek key", 10, 500),
    pairingCode: requireText(input.pairingCode, "Pairing code", 8, 32),
    personaPath: typeof input.personaPath === "string" ? input.personaPath.trim() : "",
    model: model.model,
    thinking: model.thinking,
    disclaimerAccepted: true,
  };
}
