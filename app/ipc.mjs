import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runDeployment, resumeDeployment } from "../lib/deploy.mjs";
import { createDeploymentDependencies, isWranglerAuthenticated } from "../lib/cloudflare.mjs";
import { runCommand } from "../lib/runner.mjs";

const CHANNELS = [
  "deploy:check-environment",
  "deploy:select-persona",
  "deploy:start",
  "deploy:resume",
  "deploy:cancel",
  "deploy:open-output-folder",
  "deploy:read-disclaimer",
];

function clearSecrets(input) {
  for (const key of ["telegramToken", "deepseekKey", "pairingCode"]) {
    if (Object.hasOwn(input, key)) input[key] = "";
  }
}

export function registerIpc({
  ipcMain,
  dialog,
  shell,
  appRoot,
  templateRoot,
  legalRoot,
  nodeExecutable,
  runtimeEntry,
  wranglerCli,
  runtimeEnvironment,
}) {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  let activeJob = null;

  const runBundledWrangler = (args) => runCommand(nodeExecutable, [runtimeEntry, wranglerCli, ...args], {
    cwd: appRoot,
    env: runtimeEnvironment,
  });

  ipcMain.handle("deploy:check-environment", async () => {
    // wrangler whoami exits 0 even when unauthenticated, so the output text is authoritative.
    const isReady = (result) => result.code === 0 && isWranglerAuthenticated(result.stdout + result.stderr);
    let result = await runBundledWrangler(["whoami"]);
    if (!isReady(result)) {
      const login = await runBundledWrangler(["login"]);
      if (login.code !== 0) return { ready: false, message: "Cloudflare 授权未完成，可再次检查" };
      result = await runBundledWrangler(["whoami"]);
    }
    const ready = isReady(result);
    return { ready, message: ready ? "Cloudflare 已连接" : "Cloudflare 登录状态不可用" };
  });

  ipcMain.handle("deploy:select-persona", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select persona prompt",
      properties: ["openFile"],
      filters: [{ name: "Persona prompt", extensions: ["txt", "md", "json"] }],
    });
    return result.canceled ? null : { path: result.filePaths[0], name: path.basename(result.filePaths[0]) };
  });

  async function begin(event, rawInput, resume) {
    if (activeJob !== null) throw new Error("A deployment is already running");
    const input = { ...rawInput };
    const jobId = randomUUID();
    activeJob = { id: jobId, cancelled: false };
    const dependencies = createDeploymentDependencies({
      appRoot,
      templateRoot,
      nodeExecutable,
      runtimeEntry,
      wranglerCli,
      runtimeEnvironment,
      emit: (payload) => event.sender.send("deploy:progress", { jobId, ...payload }),
      onOutput: (message) => event.sender.send("deploy:progress", {
        jobId,
        step: "log",
        status: "running",
        message: String(message).slice(0, 2_000),
        recoverable: false,
      }),
    });
    try {
      const result = resume
        ? await resumeDeployment(input, dependencies)
        : await runDeployment(input, dependencies);
      return { jobId, result };
    } finally {
      clearSecrets(input);
      activeJob = null;
    }
  }

  ipcMain.handle("deploy:start", (event, input) => begin(event, input, false));
  ipcMain.handle("deploy:resume", (event, input) => begin(event, input, true));
  ipcMain.handle("deploy:cancel", async (_event, jobId) => {
    if (activeJob === null || activeJob.id !== jobId) return { cancelled: false };
    activeJob.cancelled = true;
    return { cancelled: false, message: "The current remote step cannot be interrupted safely" };
  });
  ipcMain.handle("deploy:open-output-folder", async (_event, outputDir) => {
    if (typeof outputDir !== "string" || !path.isAbsolute(outputDir)) throw new Error("Invalid output folder");
    const error = await shell.openPath(outputDir);
    if (error) throw new Error("Unable to open output folder");
    return { opened: true };
  });
  ipcMain.handle("deploy:read-disclaimer", async (_event, language) => {
    const file = language === "zh" ? "DISCLAIMER_ZH.md" : "DISCLAIMER.md";
    return readFile(path.join(legalRoot, file), "utf8");
  });
}
