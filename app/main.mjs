import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc.mjs";
import { runCommand } from "../lib/runner.mjs";
import { createAutoUpdateController } from "../lib/auto-update.mjs";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(appDirectory, "..");
const smokeTest = process.argv.includes("--smoke-test");
const runtimeSmokeTest = process.argv.includes("--runtime-smoke-test");
const smokeOutput = process.argv.find((argument) => argument.startsWith("--smoke-test-output="))?.slice("--smoke-test-output=".length);

function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    show: false,
    title: "Cloudflare Telegram AI Bot Deployer",
    webPreferences: {
      preload: path.join(appDirectory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => window.show());
  void window.loadFile(path.join(appDirectory, "renderer", "index.html"));
  return window;
}

async function startAutoUpdates(window) {
  if (!app.isPackaged || smokeTest || runtimeSmokeTest) return;
  try {
    const module = await import("electron-updater");
    const updater = module.autoUpdater ?? module.default?.autoUpdater;
    if (!updater) return;
    createAutoUpdateController({
      updater,
      dialog,
      notify: (status) => {
        if (!window.isDestroyed()) window.webContents.send("update:status", status);
      },
    }).start({ isPackaged: true, smokeTest: false });
  } catch {
    if (!window.isDestroyed()) window.webContents.send("update:status", {
      state: "error", message: "暂时无法检查更新，不影响继续使用。",
    });
  }
}

app.whenReady().then(async () => {
  const wranglerCli = app.isPackaged
    ? path.join(repositoryRoot, "node_modules", "wrangler", "wrangler-dist", "cli.js")
    : path.join(repositoryRoot, "node_modules", "wrangler", "wrangler-dist", "cli.js");
  const runtimeEntry = path.join(appDirectory, "wrangler-runtime.cjs");
  const runtimeEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  if (app.isPackaged) {
    runtimeEnvironment.ESBUILD_BINARY_PATH = path.join(
      process.resourcesPath, "app.asar.unpacked", "node_modules", "@esbuild", "win32-x64", "esbuild.exe",
    );
  }
  if (smokeTest || runtimeSmokeTest) {
    let marker = "main-window-ready\n";
    if (runtimeSmokeTest) {
      const result = await runCommand(process.execPath, [runtimeEntry, wranglerCli, "--version"], {
        cwd: app.isPackaged ? process.resourcesPath : repositoryRoot,
        env: runtimeEnvironment,
      });
      if (result.code !== 0 || !result.stdout.includes("4.114.0")) {
        if (smokeOutput && path.isAbsolute(smokeOutput)) writeFileSync(smokeOutput, "deployment-runtime-failed\n", "utf8");
        app.exit(1);
        return;
      }
      marker += "deployment-runtime-ready\n";
    }
    process.stdout?.write(marker);
    if (smokeOutput && path.isAbsolute(smokeOutput)) writeFileSync(smokeOutput, marker, "utf8");
    app.quit();
    return;
  }
  const templateRoot = app.isPackaged
    ? path.join(process.resourcesPath, "template")
    : path.join(repositoryRoot, "template");
  const legalRoot = app.isPackaged ? process.resourcesPath : repositoryRoot;
  const runtimeRoot = app.isPackaged ? app.getPath("userData") : repositoryRoot;
  registerIpc({
    ipcMain, dialog, shell, appRoot: runtimeRoot, templateRoot, legalRoot,
    nodeExecutable: process.execPath, runtimeEntry, wranglerCli, runtimeEnvironment,
  });
  const window = createWindow();
  void startAutoUpdates(window);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
