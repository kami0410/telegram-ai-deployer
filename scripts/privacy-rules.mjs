import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const genericRules = [
  ["private-persona-marker", /\b(?:yuan|kami)\b/iu],
  ["telegram-token", /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/u],
  ["provider-key", /\b(?:sk-|tvly-)[A-Za-z0-9_-]{16,}\b/u],
  ["production-worker-url", /https?:\/\/[a-z0-9.-]+\.workers\.dev\b/iu],
  ["windows-user-path", /[A-Z]:\\Users\\[^\\\s]+/iu],
];
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/igu;
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/igu;
const secretAssignmentPattern = /(?:TOKEN|API_KEY|SECRET)\s*[:=]\s*["']([A-Za-z0-9_-]{16,})["']/giu;
const reviewedFixtureSecrets = new Set([
  "test-only-telegram-token",
  "test-only-deepseek-key",
  "test-only-webhook-secret",
  "example-telegram-token-that-is-not-valid",
]);

export function detectSensitive(text, filename = "") {
  const value = String(text);
  const findings = genericRules.filter(([, pattern]) => pattern.test(value)).map(([rule]) => rule);
  if ([...value.matchAll(uuidPattern)].some((match) => match[0] !== "00000000-0000-0000-0000-000000000000")) findings.push("non-placeholder-uuid");
  if ([...value.matchAll(emailPattern)].some((match) => !["example.invalid", "example.com"].includes(match[1].toLowerCase()))) findings.push("non-example-email");
  if ([...value.matchAll(secretAssignmentPattern)].some((match) => !reviewedFixtureSecrets.has(match[1]))) findings.push("secret-assignment");
  if (/chat[_ -]?export/iu.test(filename)) findings.push("chat-export");
  return [...new Set(findings)];
}

const skippedDirectories = new Set([".git", "node_modules", "dist", "out", ".wrangler", ".workbuddy"]);
const skippedFiles = new Set(["package-lock.json", "privacy-rules.mjs", "privacy-scan.ps1", "privacy-gate.test.mjs", "template-privacy.test.mjs", "cloudflare.test.mjs", "vitest.config.ts"]);
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsonc", ".md", ".mjs", ".ps1", ".sql", ".ts", ".txt", ".yml", ".yaml"]);
const imageExtensions = new Set([".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp"]);

async function scan(target, root, findings) {
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    if (skippedFiles.has(entry.name)) continue;
    const fullPath = path.join(target, entry.name);
    if (entry.isDirectory()) { await scan(fullPath, root, findings); continue; }
    const extension = path.extname(entry.name).toLowerCase();
    if (imageExtensions.has(extension)) { findings.push({ rule: "unreviewed-image", file: path.relative(root, fullPath) }); continue; }
    if (!textExtensions.has(extension)) continue;
    const rules = detectSensitive(await readFile(fullPath, "utf8"), entry.name);
    for (const rule of rules) findings.push({ rule, file: path.relative(root, fullPath) });
  }
}

export async function scanPrivacyRoot(root) {
  const findings = [];
  await scan(path.resolve(root), path.resolve(root), findings);
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const findings = await scanPrivacyRoot(process.argv[2]);
  for (const finding of findings) process.stderr.write(`privacy finding: ${finding.rule} in ${finding.file}\n`);
  if (findings.length > 0) process.exitCode = 1;
}
