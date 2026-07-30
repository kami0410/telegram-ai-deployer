import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createPreloadApi } from "../app/preload-api.mjs";

test("preload exposes only the approved frozen deployment API", () => {
  const listeners = new Map();
  const ipcRenderer = {
    invoke: async (channel, value) => ({ channel, value }),
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const exposed = createPreloadApi(ipcRenderer);
  assert.deepEqual(Object.keys(exposed).sort(), [
    "cancel",
    "checkEnvironment",
    "onProgress",
    "openOutputFolder",
    "readDisclaimer",
    "resume",
    "selectPersona",
    "start",
  ]);
  assert.equal(Object.isFrozen(exposed), true);
  const unsubscribe = exposed.onProgress(() => {});
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test("main window uses hardened local-only web preferences", async () => {
  const source = await readFile("app/main.mjs", "utf8");
  assert.match(source, /preload:\s*path\.join\(appDirectory,\s*"preload\.cjs"\)/u);
  assert.match(source, /nodeIntegration:\s*false/u);
  assert.match(source, /contextIsolation:\s*true/u);
  assert.match(source, /sandbox:\s*true/u);
  assert.match(source, /webSecurity:\s*true/u);
  assert.match(source, /will-navigate/u);
  assert.match(source, /setWindowOpenHandler/u);
});

test("packaged-compatible CommonJS preload exposes the deployment API", async () => {
  const source = await readFile("app/preload.cjs", "utf8");
  let exposedName;
  let exposedApi;
  const ipcRenderer = {
    invoke: async () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  };
  const contextBridge = {
    exposeInMainWorld(name, api) {
      exposedName = name;
      exposedApi = api;
    },
  };
  const require = (specifier) => {
    assert.equal(specifier, "electron");
    return { contextBridge, ipcRenderer };
  };

  vm.runInNewContext(source, { require, Object, TypeError });

  assert.equal(exposedName, "deployer");
  assert.equal(typeof exposedApi?.selectPersona, "function");
  assert.equal(typeof exposedApi?.checkEnvironment, "function");
  assert.equal(typeof exposedApi?.onProgress, "function");
  assert.equal(Object.isFrozen(exposedApi), true);
});

test("environment check can complete Cloudflare login through the bundled runtime", async () => {
  const source = await readFile("app/ipc.mjs", "utf8");
  assert.match(source, /runBundledWrangler\(\["whoami"\]\)/u);
  assert.match(source, /runBundledWrangler\(\["login"\]\)/u);
  assert.doesNotMatch(source, /npx|npm\.cmd/u);
});

test("environment check parses whoami output instead of trusting the exit code", async () => {
  const source = await readFile("app/ipc.mjs", "utf8");
  assert.match(source, /isWranglerAuthenticated/u);
});
