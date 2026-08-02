import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile); const dir = await mkdtemp(join(tmpdir(), "persona-gate-"));
try {
  const summary = { total: 100, criticalFailures: 0, dimensions: { persona: { passRate: 1 } } };
  const baseline = join(dir, "baseline.json"); const candidate = join(dir, "candidate.json");
  await writeFile(baseline, JSON.stringify({ summary }), "utf8");
  await writeFile(candidate, JSON.stringify({ summary, metadata: { model: "flash", personaVersion: 8, workerVersion: "abc" } }), "utf8");
  const gate = fileURLToPath(new URL("./persona-release-gate.mjs", import.meta.url));
  const { stdout } = await exec(process.execPath, [gate, "--candidate", candidate, "--baseline", baseline]);
  const result = JSON.parse(stdout); assert.equal(result.passed, true); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  console.log("persona release gate self-test passed");
} finally { await rm(dir, { recursive: true, force: true }); }
