import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(source, /nodeIntegration:\s*false/u);
  assert.match(source, /contextIsolation:\s*true/u);
  assert.match(source, /sandbox:\s*true/u);
  assert.match(source, /webSecurity:\s*true/u);
  assert.match(source, /will-navigate/u);
  assert.match(source, /setWindowOpenHandler/u);
});

test("environment check can complete Cloudflare login through the bundled runtime", async () => {
  const source = await readFile("app/ipc.mjs", "utf8");
  assert.match(source, /runBundledWrangler\(\["whoami"\]\)/u);
  assert.match(source, /runBundledWrangler\(\["login"\]\)/u);
  assert.doesNotMatch(source, /npx|npm\.cmd/u);
});
