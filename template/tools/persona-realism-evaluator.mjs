import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  evaluateSyntheticReply,
  summarizeEvaluation,
} from "../src/quality-evaluation.ts";

function usage() {
  return {
    usage: "node tools/persona-realism-evaluator.mjs <replies.json> [--baseline <report.json>]",
    format: [{ id: "persona_01", reply: "..." }],
    privacy: "Only explicitly supplied synthetic files are read; production chat storage is never scanned.",
  };
}

function baselineRegressions(summary, baseline) {
  if (!baseline) return [];
  const previous = baseline.summary ?? baseline;
  const regressions = [];
  if (Number(previous.total) !== summary.total) regressions.push("scenario_count");
  if (summary.criticalFailures > Number(previous.criticalFailures ?? 0)) {
    regressions.push("critical_failures");
  }
  for (const [dimension, current] of Object.entries(summary.dimensions)) {
    const prior = previous.dimensions?.[dimension];
    if (prior && current.passRate + 0.000_001 < Number(prior.passRate)) {
      regressions.push(`dimension:${dimension}`);
    }
  }
  return regressions;
}

const inputPath = process.argv[2];
if (!inputPath || inputPath.startsWith("--")) {
  console.log(JSON.stringify(usage(), null, 2));
  process.exitCode = inputPath ? 2 : 0;
} else {
  const baselineFlag = process.argv.indexOf("--baseline");
  const baselinePath = baselineFlag >= 0 ? process.argv[baselineFlag + 1] : undefined;
  if (baselineFlag >= 0 && !baselinePath) throw new Error("baseline_path_missing");
  const qualitySet = JSON.parse(await readFile(
    new URL("../config/realism-scenarios-v2.json", import.meta.url),
    "utf8",
  ));
  if (qualitySet.version !== 2 || !Array.isArray(qualitySet.scenarios)) {
    throw new Error("quality_scenario_schema_invalid");
  }
  const supplied = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(supplied)) throw new Error("quality_replies_invalid");
  const replies = new Map(supplied.map((item) => [String(item.id), String(item.reply ?? "")]));
  const results = qualitySet.scenarios.map((scenario) =>
    evaluateSyntheticReply(scenario, replies.get(scenario.id) ?? "")
  );
  const summary = summarizeEvaluation(results);
  const baseline = baselinePath
    ? JSON.parse(await readFile(baselinePath, "utf8"))
    : null;
  const regressions = baselineRegressions(summary, baseline);
  const openings = supplied
    .map((item) => String(item.reply ?? "").trim().slice(0, 12))
    .filter(Boolean);
  const repeatedOpenings = openings.length - new Set(openings).size;
  const report = {
    version: qualitySet.version,
    generatedAt: new Date().toISOString(),
    summary,
    repeatedOpenings,
    regressions,
    results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (summary.criticalFailures > 0 || regressions.length > 0) process.exitCode = 1;
}
