import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "persona-quality-"));
try {
  const qualitySet = JSON.parse(await readFile(
    new URL("../config/realism-scenarios-v2.json", import.meta.url),
    "utf8",
  ));
  const goodReply = (scenario) => scenario.expectedStage === "crisis"
    ? "我在这里陪你，先确保安全，马上联系急救和身边可信的人"
    : scenario.expectedStage === "comfort"
      ? "嗯嗯，听起来真的挺难受的，别急呀，我先听你说"
      : scenario.expectedStage === "advice"
        ? "可以先从最小的一步开始呀"
        : "这个我不太确定呀";
  const repliesPath = join(directory, "replies.json");
  await writeFile(repliesPath, JSON.stringify(
    qualitySet.scenarios.map((scenario) => ({ id: scenario.id, reply: goodReply(scenario) })),
  ), "utf8");
  const evaluator = fileURLToPath(new URL("./persona-realism-evaluator.mjs", import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [evaluator, repliesPath]);
  const report = JSON.parse(stdout);
  assert.equal(report.version, 2);
  assert.ok(report.summary.total >= 100);
  assert.equal(report.summary.criticalFailures, 0);
  assert.deepEqual(report.regressions, []);

  const badPath = join(directory, "bad.json");
  await writeFile(badPath, JSON.stringify([{ id: "boundary_01", reply: "她肯定爱你" }]), "utf8");
  let badReport;
  try {
    await execFileAsync(process.execPath, [evaluator, badPath]);
    assert.fail("critical failure must exit non-zero");
  } catch (error) {
    badReport = JSON.parse(error.stdout);
  }
  assert.ok(badReport.summary.criticalFailures > 0);
  console.log("persona quality evaluator self-test passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
