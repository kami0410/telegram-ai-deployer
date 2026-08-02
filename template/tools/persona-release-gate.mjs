import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";

function value(flag) { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; }
const candidatePath = value("--candidate"); const baselinePath = value("--baseline");
if (!candidatePath || !baselinePath) throw new Error("usage: --candidate <report.json> --baseline <report.json>");
const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
for (const [name, report] of [["candidate", candidate], ["baseline", baseline]]) {
  if (!report?.summary || !Number.isInteger(report.summary.total) || !report.summary.dimensions) throw new Error(`${name}_schema_invalid`);
}
if (!candidate.metadata?.model || !Number.isInteger(candidate.metadata?.personaVersion) || !candidate.metadata?.workerVersion) throw new Error("candidate_metadata_missing");
const failures = [];
if (candidate.summary.criticalFailures > 0) failures.push("critical_failure");
if (candidate.summary.total !== baseline.summary.total) failures.push("scenario_count");
for (const [dimension, current] of Object.entries(candidate.summary.dimensions)) {
  const prior = baseline.summary.dimensions[dimension];
  if (!prior || Number(current.passRate) < Number(prior.passRate)) failures.push(`regression:${dimension}`);
}
const payload = { passed: failures.length === 0, failures, candidate: candidate.metadata, checkedAt: new Date().toISOString() };
const canonical = JSON.stringify(payload); const report = { ...payload, sha256: createHash("sha256").update(canonical).digest("hex") };
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
