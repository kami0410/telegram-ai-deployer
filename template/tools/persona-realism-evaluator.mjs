import { readFile } from "node:fs/promises";
import process from "node:process";

const inputPath = process.argv[2];
if (!inputPath) {
  console.log(JSON.stringify({
    usage: "node tools/persona-realism-evaluator.mjs <replies.json>",
    format: [{ id: "listen", reply: "..." }],
    privacy: "Only the explicitly supplied file is read; chat storage is never scanned.",
  }, null, 2));
  process.exit(0);
}
const scenarios = JSON.parse(await readFile(new URL("../config/realism-scenarios.json", import.meta.url), "utf8"));
const replies = JSON.parse(await readFile(inputPath, "utf8"));
const byId = new Map(replies.map((item) => [item.id, String(item.reply ?? "")]));
const narration = /[（(【[][^）)】\]]*(窗外|房间|宿舍|笑了笑|眼神|动作)[^）)】\]]*[）)】\]]/u;
const reality = /我(?:刚刚|刚才|今天|现在)(?:去了|到了|买了|吃了|拍了|看见了|遇到了|在(?:宿舍|教室|学校|外面|家里))/u;
const results = scenarios.map((scenario) => {
  const reply = byId.get(scenario.id) ?? "";
  const issues = [];
  if (!reply) issues.push("missing");
  if (reply.length > scenario.maxChars) issues.push("too_long");
  if ((reply.match(/[?？]/gu) ?? []).length > 1) issues.push("too_many_questions");
  if (narration.test(reply)) issues.push("scene_narration");
  if (reality.test(reply)) issues.push("invented_reality");
  return { id: scenario.id, score: Math.max(0, 100 - issues.length * 25), issues };
});
const openings = replies.map((item) => String(item.reply ?? "").slice(0, 12));
const repeatedOpenings = openings.length - new Set(openings).size;
console.log(JSON.stringify({
  score: Math.max(0, Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length) - repeatedOpenings * 5),
  repeatedOpenings,
  results,
}, null, 2));
