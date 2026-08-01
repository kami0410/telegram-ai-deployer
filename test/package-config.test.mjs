import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Windows package has x64 installer, archive, and selectable destination", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts.make, /--x64/u);
  assert.deepEqual(packageJson.build.win.target, ["nsis", "zip"]);
  assert.equal(packageJson.build.win.artifactName, "Telegram.AI.Deployer-${version}-${arch}.${ext}");
  assert.equal(packageJson.build.nsis.oneClick, false);
  assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.equal(packageJson.build.asar, true);
  assert.equal(packageJson.dependencies.wrangler, "4.114.0");
  assert.equal(typeof packageJson.dependencies["electron-updater"], "string");
  const publicOwner = ["ka", "mi0410"].join("");
  assert.deepEqual(packageJson.build.publish, [{
    provider: "github",
    owner: publicOwner,
    repo: "telegram-ai-deployer",
  }]);
});

test("filesystem resources are unpacked and private artifacts are excluded", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const destinations = packageJson.build.extraResources.map((entry) => entry.to).sort();
  assert.deepEqual(destinations, ["DISCLAIMER.md", "DISCLAIMER_ZH.md", "template"]);
  const serialized = JSON.stringify(packageJson.build);
  assert.doesNotMatch(serialized, /\.env|deployment-state|generated-project|fixtures/u);
  assert.doesNotMatch(serialized, /GH_TOKEN|githubToken|private/u);
});

test("installer verifier checks custom path, launch, resources, uninstall, and hash", async () => {
  const script = await readFile("scripts/verify-installer.ps1", "utf8");
  for (const marker of ["main-window-ready", "deployment-runtime-ready", "DISCLAIMER_ZH.md", "template", "Get-FileHash", "Uninstall", "CODEX_INSTALL_ROOT"]) {
    assert.match(script, new RegExp(marker, "u"));
  }
  assert.match(script, /\*\.zip/u);
  assert.match(script, /Length\s*-le\s*0/u);
});

test("packaged runtime resolves native esbuild only from Electron's unpacked resources", async () => {
  const source = await readFile("app/main.mjs", "utf8");
  assert.match(source, /ESBUILD_BINARY_PATH/u);
  assert.match(source, /app\.asar\.unpacked/u);
  assert.doesNotMatch(source, /process\.env\.PATH\s*=/u);
});
