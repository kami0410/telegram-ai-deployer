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

test("rejects an executable that merely spoofs the trusted basename", async () => {
  const spoofed = process.platform === "win32" ? "C:\\untrusted\\node.exe" : "/untrusted/node";
  await assert.rejects(() => runCommand(spoofed, ["--version"]), /not allowed/iu);
});

test("runs the bundled Wrangler entrypoint with the trusted runtime", async () => {
  const wranglerCli = new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/u, "$1");
  const runtimeEntry = new URL("../app/wrangler-runtime.cjs", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/u, "$1");
  const result = await runCommand(process.execPath, [runtimeEntry, wranglerCli, "--version"], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /4\.114\.0/u);
});
