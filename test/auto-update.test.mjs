import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAutoUpdateController } from "../lib/auto-update.mjs";

function createUpdater() {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.checks = 0;
  updater.downloads = 0;
  updater.installs = 0;
  updater.checkForUpdates = async () => { updater.checks += 1; };
  updater.downloadUpdate = async () => { updater.downloads += 1; };
  updater.quitAndInstall = () => { updater.installs += 1; };
  return updater;
}

test("automatic updates are disabled outside packaged production runs", () => {
  const updater = createUpdater();
  let scheduled = 0;
  const controller = createAutoUpdateController({
    updater,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    notify: () => {},
    setTimeoutFn: () => { scheduled += 1; },
    setIntervalFn: () => { scheduled += 1; },
  });

  controller.start({ isPackaged: false, smokeTest: false });
  controller.start({ isPackaged: true, smokeTest: true });

  assert.equal(scheduled, 0);
  assert.equal(updater.checks, 0);
});

test("packaged app checks automatically and downloads only after consent", async () => {
  const updater = createUpdater();
  const statuses = [];
  const scheduled = [];
  let response = 1;
  const controller = createAutoUpdateController({
    updater,
    dialog: { showMessageBox: async () => ({ response }) },
    notify: (status) => statuses.push(status),
    setTimeoutFn: (callback, delay) => { scheduled.push({ callback, delay }); return 1; },
    setIntervalFn: () => 2,
  });

  controller.start({ isPackaged: true, smokeTest: false });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 8_000);
  await scheduled[0].callback();
  assert.equal(updater.checks, 1);

  updater.emit("update-available", { version: "1.1.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.downloads, 0);

  response = 0;
  updater.emit("update-available", { version: "1.1.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.downloads, 1);
  assert.ok(statuses.some((status) => status.state === "available"));
});

test("downloaded update installs only after restart confirmation and errors stay non-blocking", async () => {
  const updater = createUpdater();
  const statuses = [];
  let response = 1;
  const controller = createAutoUpdateController({
    updater,
    dialog: { showMessageBox: async () => ({ response }) },
    notify: (status) => statuses.push(status),
    setTimeoutFn: () => 1,
    setIntervalFn: () => 2,
  });
  controller.start({ isPackaged: true, smokeTest: false });

  updater.emit("update-downloaded", { version: "1.1.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.installs, 0);

  response = 0;
  updater.emit("update-downloaded", { version: "1.1.0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.installs, 1);

  updater.emit("error", new Error("offline"));
  assert.deepEqual(statuses.at(-1), {
    state: "error",
    message: "暂时无法检查更新，不影响继续使用。",
  });
});
