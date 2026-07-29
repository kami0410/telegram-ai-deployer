import { spawn } from "node:child_process";
import path from "node:path";

function executableName(value) {
  return path.basename(value).toLowerCase();
}

export async function runCommand(executable, args, {
  cwd,
  input,
  redact = (value) => String(value),
  onOutput = () => {},
  env = process.env,
} = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Command arguments must be a string array");
  }
  const allowed = new Set(["npm", "npm.cmd", "npx", "npx.cmd", "node", "node.exe"]);
  if (!allowed.has(executableName(executable))) throw new Error("Executable is not allowed");

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onOutput(redact(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onOutput(redact(chunk));
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
