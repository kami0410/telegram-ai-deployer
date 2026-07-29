import { spawn } from "node:child_process";
import path from "node:path";

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
  const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(path.resolve(executable)) !== normalize(path.resolve(process.execPath))) {
    throw new Error("Executable is not allowed");
  }

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
