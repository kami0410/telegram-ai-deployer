import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../lib/runner.mjs";
import { createRedactor } from "../lib/redact.mjs";

test("runs an argument-array command and redacts streamed output", async () => {
  const output = [];
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('example-secret')"], {
    redact: createRedactor(["example-secret"]),
    onOutput: (text) => output.push(String(text)),
  });
  assert.equal(result.code, 0);
  assert.equal(output.join(""), "[REDACTED]");
});

test("rejects arbitrary executables", async () => {
  await assert.rejects(() => runCommand("powershell.exe", ["-Command", "Write-Host unsafe"]), /not allowed/iu);
});
