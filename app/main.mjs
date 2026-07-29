import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc.mjs";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(appDirectory, "..");
const smokeTest = process.argv.includes("--smoke-test");

function createWindow() {
  const window = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    show: false,
    title: "Cloudflare Telegram AI Bot Deployer",
    webPreferences: {
      preload: path.join(appDirectory, "preload.mjs"),
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

app.whenReady().then(() => {
  if (smokeTest) {
    process.stdout.write("main-window-ready\n");
    app.quit();
    return;
  }
  const templateRoot = app.isPackaged
    ? path.join(process.resourcesPath, "template")
    : path.join(repositoryRoot, "template");
  const legalRoot = app.isPackaged ? process.resourcesPath : repositoryRoot;
  registerIpc({ ipcMain, dialog, shell, appRoot: repositoryRoot, templateRoot, legalRoot });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
