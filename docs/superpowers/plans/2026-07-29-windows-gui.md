# Windows Visual Deployment GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a privacy-safe Windows Electron installer that visually deploys a generic Cloudflare Telegram/DeepSeek bot and supports explicit model and thinking-mode choices.

**Architecture:** A framework-independent core owns validation, template generation, Wrangler orchestration, redaction, progress, and resume state. Electron Main calls that core through a narrow Preload bridge; a local-only Renderer implements the five-step wizard. A sanitized bot template ships as an unpacked application resource and never reads the private project at runtime.

**Tech Stack:** Node.js 22, Electron, Electron Forge, vanilla HTML/CSS/JavaScript, Wrangler 4, Node test runner, PowerShell verification scripts, Windows x64 installer and portable archive.

## Global Constraints

- Work only in this repository root; do not modify any existing project outside it.
- First release supports Windows 10/11 x64 only.
- Allow only deepseek-v4-flash and deepseek-v4-pro; default to Flash.
- Render thinking mode as thinking.type = enabled or disabled.
- Never store secrets, persona content, private paths, production URLs, account IDs, chat data, or resource IDs in Git or logs.
- Renderer loads local files only with nodeIntegration false, contextIsolation true, sandbox true.
- Clear password fields immediately after submission; Main never echoes secrets to Renderer.
- Public Git history begins in this clean repository.
- The installer allows a custom installation path.
- DISCLAIMER.md and DISCLAIMER_ZH.md are release-blocking and prominently linked.
- Tests use example.invalid, zero UUIDs, and values that cannot be valid provider tokens.

---

## File Map

- app/main.mjs: Electron lifecycle and hardened BrowserWindow.
- app/ipc.mjs: narrow IPC handlers and secret-clearing boundary.
- app/preload.mjs: frozen window.deployer API.
- app/renderer/: five-step wizard.
- lib/models.mjs: model whitelist and thinking configuration.
- lib/validation.mjs: input and disclaimer validation.
- lib/redact.mjs: log redaction.
- lib/runner.mjs: argument-array-only child processes.
- lib/template.mjs: sanitized template generation.
- lib/cloudflare.mjs: idempotent Wrangler operations.
- lib/deploy.mjs: deployment state machine and resume.
- template/: generic Worker source, migrations, tests, and configs.
- scripts/privacy-scan.ps1: source, history, installer, and generated-output scanner.
- scripts/verify-installer.ps1: custom-path install, launch, uninstall, and residue checks.
- forge.config.cjs: Windows packaging.

### Task 1: Public repository shell and legal/privacy documents

**Files:**
- Create: package.json
- Create: .gitignore
- Create: .gitattributes
- Create: LICENSE
- Create: README.md
- Create: README_ZH.md
- Create: DISCLAIMER.md
- Create: DISCLAIMER_ZH.md
- Create: PRIVACY.md
- Create: SECURITY.md
- Create: CONTRIBUTING.md
- Test: test/public-docs.test.mjs

**Interfaces:**
- Produces: npm test, npm run privacy:scan, and public documents consumed by packaging.

- [ ] **Step 1: Write the failing public-document test**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("public docs expose disclaimers and contain no deployment identity", async () => {
  for (const file of ["README.md", "README_ZH.md"]) {
    const text = await readFile(file, "utf8");
    assert.match(text, /DISCLAIMER/u);
    assert.doesNotMatch(text, /\.workers\.dev|account[_ -]?id/iu);
  }
  for (const file of ["DISCLAIMER.md", "DISCLAIMER_ZH.md"]) {
    const text = (await readFile(file, "utf8")).toLowerCase();
    for (const concept of ["cloudflare", "telegram", "deepseek", "ai", "privacy"]) {
      assert.match(text, new RegExp(concept, "u"));
    }
  }
});
~~~

- [ ] **Step 2: Run the test and verify it fails**

Run: node --test test/public-docs.test.mjs

Expected: FAIL with ENOENT for README.md.

- [ ] **Step 3: Add package metadata and public documents**

Create package.json with type module, Node >=22, and scripts test, privacy:scan, start, package, and make. Write the MIT license with author Open Source Maintainers. Both disclaimers contain: no affiliation or endorsement; third-party terms and billing; credentials and cloud resources; privacy and authorization for real-person data; prohibited impersonation, harassment, and monitoring; AI limitations and no professional advice; backups, security, and incident response; no warranty; legally permitted liability limitation; third-party intellectual property; service changes; private vulnerability reporting; translation note; recommendation for legal review.

README.md begins with:

~~~md
> [!IMPORTANT]
> This independent project is not affiliated with or endorsed by Cloudflare, Telegram, or DeepSeek. Before use, read [DISCLAIMER.md](DISCLAIMER.md), [PRIVACY.md](PRIVACY.md), and third-party terms and pricing.
~~~

.gitignore includes node_modules, out, dist, generated, logs, certificates, all environment files except .env.example, imported-prompt.ts, and deployment-state.json.

- [ ] **Step 4: Run document tests**

Run: node --test test/public-docs.test.mjs

Expected: one PASS and zero failures.

- [ ] **Step 5: Commit**

~~~powershell
git add package.json .gitignore .gitattributes LICENSE README.md README_ZH.md DISCLAIMER.md DISCLAIMER_ZH.md PRIVACY.md SECURITY.md CONTRIBUTING.md test/public-docs.test.mjs
git commit -m "docs: establish privacy-safe public project"
~~~

### Task 2: Sanitized generic bot template and model configuration

**Files:**
- Create: template/src/
- Create: template/migrations/
- Create: template/test/
- Create: template/package.json
- Create: template/wrangler.template.jsonc
- Create: lib/models.mjs
- Test: test/models.test.mjs
- Test: test/template-privacy.test.mjs

**Interfaces:**
- Produces: MODELS, normalizeModelSelection(input), and a template accepting DEEPSEEK_MODEL and DEEPSEEK_THINKING_MODE.

- [ ] **Step 1: Write failing model tests**

~~~js
import test from "node:test";
import assert from "node:assert/strict";
import { MODELS, normalizeModelSelection } from "../lib/models.mjs";

test("allows only current DeepSeek V4 models", () => {
  assert.deepEqual(MODELS.map(({ id }) => id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(normalizeModelSelection({ model: "deepseek-v4-flash", thinking: false }), {
    model: "deepseek-v4-flash",
    thinking: "disabled",
  });
  assert.throws(() => normalizeModelSelection({ model: "deepseek-chat", thinking: true }), /unsupported model/iu);
});
~~~

- [ ] **Step 2: Verify the missing-module failure**

Run: node --test test/models.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement the model whitelist**

~~~js
export const MODELS = Object.freeze([
  Object.freeze({ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", recommended: true }),
  Object.freeze({ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", recommended: false }),
]);

export function normalizeModelSelection({ model, thinking }) {
  if (!MODELS.some((candidate) => candidate.id === model)) throw new Error("Unsupported model");
  return { model, thinking: thinking ? "enabled" : "disabled" };
}
~~~

- [ ] **Step 4: Create the generic template without private files or history**

Copy only required runtime modules, migrations, and tests into template. Replace product-specific nouns with Personal Bot; use an empty imported-prompt.ts; exclude production configs, manuals, screenshots, fixtures, URLs, IDs, and authored persona defaults. DeepSeek requests include:

~~~js
{
  model: env.DEEPSEEK_MODEL,
  thinking: { type: env.DEEPSEEK_THINKING_MODE === "enabled" ? "enabled" : "disabled" },
  messages,
  max_tokens: Number(env.MAX_OUTPUT_TOKENS),
}
~~~

- [ ] **Step 5: Add and run template privacy tests**

Recursively read template text files and reject workers.dev URLs, non-zero UUIDs, Telegram-token shapes, secret prefixes, real-person labels, chat-export markers, and absolute drive paths.

Run: node --test test/models.test.mjs test/template-privacy.test.mjs; npm --prefix template test

Expected: all root and template tests PASS.

- [ ] **Step 6: Commit**

~~~powershell
git add lib/models.mjs template test/models.test.mjs test/template-privacy.test.mjs
git commit -m "feat: add sanitized generic bot template"
~~~

### Task 3: Framework-independent deployment core

**Files:**
- Create: lib/validation.mjs
- Create: lib/redact.mjs
- Create: lib/runner.mjs
- Create: lib/template.mjs
- Create: lib/cloudflare.mjs
- Create: lib/deploy.mjs
- Test: test/validation.test.mjs
- Test: test/redact.test.mjs
- Test: test/deploy.test.mjs

**Interfaces:**
- Consumes: normalizeModelSelection(input) and template/.
- Produces: validateDeploymentInput(input), createRedactor(secrets), runCommand(executable,args,options), runDeployment(input,deps), and resumeDeployment(input,deps).

- [ ] **Step 1: Write failing validation and redaction tests**

~~~js
test("normalizes a safe deployment input", () => {
  const result = validateDeploymentInput({
    projectName: "Example Bot",
    outputDir: "D:\\Bots\\example-bot",
    telegramToken: "example-telegram-token-that-is-not-valid",
    deepseekKey: "example-deepseek-key-that-is-not-valid",
    pairingCode: "example-1234",
    model: "deepseek-v4-flash",
    thinking: false,
    disclaimerAccepted: true,
  });
  assert.equal(result.projectName, "example-bot");
});

test("redacts exact secrets", () => {
  const redact = createRedactor(["example-secret-value"]);
  assert.equal(redact("failed example-secret-value"), "failed [REDACTED]");
});
~~~

- [ ] **Step 2: Verify the missing-module failures**

Run: node --test test/validation.test.mjs test/redact.test.mjs

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement validation, redaction, and process execution**

runCommand calls spawn(executable, args, { shell: false, windowsHide: true }), accepts optional stdin, streams redacted output, and returns code, stdout, stderr. It rejects executable paths outside internally resolved npm.cmd, npx.cmd, and packaged Electron-as-Node runtime paths.

- [ ] **Step 4: Write the failing deployment-state test**

~~~js
test("emits ordered progress and never persists secrets", async () => {
  const events = [];
  const files = new Map();
  await runDeployment(exampleInput, fakeDependencies({ events, files }));
  assert.deepEqual(events.filter((event) => event.status === "succeeded").map((event) => event.step), [
    "environment", "template", "d1", "queues", "vectorize", "migration",
    "first-deploy", "secrets", "final-deploy", "webhook", "health",
  ]);
  assert.doesNotMatch(files.get("deployment-state.json"), /example-deepseek|example-telegram/iu);
});
~~~

- [ ] **Step 5: Implement the idempotent state machine**

Persist only version, projectName, outputDir, model, thinking, completedSteps, generated resource names, workerUrl, and updatedAt. Query before creating D1, two Queues, 1024-dimension cosine Vectorize and metadata indexes. Run remote migrations, first deploy, secret bulk through stdin, final deploy, Telegram setWebhook, and Worker health. Generate Webhook Secret in Main memory and never persist it.

- [ ] **Step 6: Verify and commit**

Run: node --test test/validation.test.mjs test/redact.test.mjs test/deploy.test.mjs

Expected: all PASS and fixture storage contains no secret.

~~~powershell
git add lib test/validation.test.mjs test/redact.test.mjs test/deploy.test.mjs
git commit -m "feat: add resumable Cloudflare deployment core"
~~~

### Task 4: Hardened Electron shell and IPC contract

**Files:**
- Create: app/main.mjs
- Create: app/ipc.mjs
- Create: app/preload.mjs
- Create: test/ipc.test.mjs
- Modify: package.json

**Interfaces:**
- Consumes: runDeployment, resumeDeployment, and validators.
- Produces: window.deployer methods checkEnvironment, selectPersona, start, resume, cancel, onProgress, openOutputFolder, and readDisclaimer.

- [ ] **Step 1: Write the failing IPC policy test**

~~~js
test("preload exposes only the approved API", async () => {
  const exposed = await loadPreloadWithFakeContextBridge();
  assert.deepEqual(Object.keys(exposed).sort(), [
    "cancel", "checkEnvironment", "onProgress", "openOutputFolder",
    "readDisclaimer", "resume", "selectPersona", "start",
  ]);
  assert.equal(Object.isFrozen(exposed), true);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test test/ipc.test.mjs

Expected: FAIL because app/preload.mjs is missing.

- [ ] **Step 3: Implement hardened Main and IPC**

Create BrowserWindow with local preload, nodeIntegration false, contextIsolation true, sandbox true, and webSecurity true. Deny navigation and new windows. Validate every IPC payload in Main, allow one deployment job, clear received secret properties in finally, and never include them in progress or errors.

- [ ] **Step 4: Verify and commit**

Run: node --test test/ipc.test.mjs; npm run start -- --smoke-test

Expected: tests PASS and smoke mode prints main-window-ready before exit 0.

~~~powershell
git add app/main.mjs app/ipc.mjs app/preload.mjs test/ipc.test.mjs package.json package-lock.json
git commit -m "feat: add hardened Electron deployment shell"
~~~

### Task 5: Five-step Windows wizard and model controls

**Files:**
- Create: app/renderer/index.html
- Create: app/renderer/app.mjs
- Create: app/renderer/styles.css
- Test: test/renderer.test.mjs

**Interfaces:**
- Consumes: frozen window.deployer API and model metadata.
- Produces: accessible wizard with disclaimer gate.

- [ ] **Step 1: Write failing Renderer tests**

Assert Flash is the default, only two model IDs exist, deployment is disabled until disclaimer acceptance, three secret inputs use password type, submitting clears them synchronously, and failed progress exposes retry without raw stderr.

Run: node --test test/renderer.test.mjs

Expected: FAIL because Renderer files are absent.

- [ ] **Step 2: Implement semantic wizard markup**

Use five section elements, progress list, explicit labels, aria-live progress, model cards, thinking checkbox, persona file picker, confirmation resource table, disclaimer checkbox, and deployment controls. Load no remote scripts, fonts, images, analytics, or embedded pages.

- [ ] **Step 3: Implement secret clearing and non-secret state**

On submit, copy values into a one-use payload, immediately clear password controls, call start, then blank payload secret properties in finally. Retain only non-secret summary fields.

- [ ] **Step 4: Add system-theme styling**

Use CSS variables, prefers-color-scheme, visible focus, 44px actions, responsive 900x680 layout, and reduced-motion support.

- [ ] **Step 5: Verify and commit**

Run: node --test test/renderer.test.mjs; npm test

Expected: all PASS.

~~~powershell
git add app/renderer test/renderer.test.mjs
git commit -m "feat: add visual Windows deployment wizard"
~~~

### Task 6: Resume UX and integrated disclaimers

**Files:**
- Modify: app/renderer/index.html
- Modify: app/renderer/app.mjs
- Modify: app/ipc.mjs
- Test: test/resume-ui.test.mjs
- Test: test/disclaimer-ui.test.mjs

**Interfaces:**
- Consumes: sanitized progress events and local disclaimer text.
- Produces: retryable progress and local legal-notice views.

- [ ] **Step 1: Write failing UI tests**

~~~js
test("recoverable failure enables resume", async () => {
  const ui = await renderWizard();
  ui.emitProgress({ step: "vectorize", status: "failed", message: "Request failed", recoverable: true });
  assert.equal(ui.resumeButton.disabled, false);
});

test("disclaimer opens from confirmation and about views", async () => {
  const ui = await renderWizard();
  assert.equal(ui.disclaimerLinks.length, 2);
  await ui.disclaimerLinks[0].click();
  assert.match(ui.dialog.textContent, /Cloudflare|Telegram|DeepSeek/u);
});
~~~

- [ ] **Step 2: Verify failure**

Run: node --test test/resume-ui.test.mjs test/disclaimer-ui.test.mjs

Expected: FAIL because resume and notice views are absent.

- [ ] **Step 3: Implement resume and notices**

Render step states separately, preserve completed steps, require secrets to be re-entered for resume, and show resource/cost warning before deployment. Load disclaimers through IPC as escaped plain text, never HTML.

- [ ] **Step 4: Verify and commit**

Run: node --test test/resume-ui.test.mjs test/disclaimer-ui.test.mjs; npm test

Expected: all PASS.

~~~powershell
git add app test/resume-ui.test.mjs test/disclaimer-ui.test.mjs
git commit -m "feat: add safe deployment recovery and notices"
~~~

### Task 7: Windows packaging with custom install path

**Files:**
- Create: forge.config.cjs
- Create: assets/icon.ico
- Create: scripts/verify-installer.ps1
- Modify: package.json
- Test: test/package-config.test.mjs

**Interfaces:**
- Produces: x64 installer, portable archive, unpacked template/disclaimers, and SHA-256.

- [ ] **Step 1: Write the failing package test**

Verify x64 Windows targets, bundled disclaimers/template, no auto-update, selectable installation destination, and exclusion of environment files, generated projects, fixture secrets, and deployment state.

Run: node --test test/package-config.test.mjs

Expected: FAIL because forge.config.cjs is missing.

- [ ] **Step 2: Configure Electron Forge**

Use a Windows maker with per-user installation and selectable destination. Keep template and legal documents outside ASAR where filesystem access is required. Produce installer and portable archive under out/make.

- [ ] **Step 3: Implement safe installer verification**

The PowerShell script resolves exactly one new installer, creates a verified temporary path under TEMP, installs to that explicit path, launches --smoke-test, requires main-window-ready, checks bundled template/disclaimers, uninstalls, confirms the install path is gone, and writes SHA-256. It refuses targets outside its own temporary directory.

- [ ] **Step 4: Build, verify, and commit**

~~~powershell
npm run make
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-installer.ps1
~~~

Expected: build, custom-path install, launch, uninstall, residue, and hash checks PASS.

~~~powershell
git add forge.config.cjs assets/icon.ico scripts/verify-installer.ps1 package.json package-lock.json test/package-config.test.mjs
git commit -m "build: package verified Windows installer"
~~~

### Task 8: Privacy gate, real acceptance, and GitHub release readiness

**Files:**
- Create: scripts/privacy-scan.ps1
- Create: docs/architecture.md
- Create: docs/release-checklist.md
- Modify: README.md
- Modify: README_ZH.md
- Test: test/privacy-script.test.mjs

**Interfaces:**
- Consumes: source, Git objects, generated dry-run project, and extracted installer.
- Produces: zero-unreviewed-finding release gate and non-secret acceptance record.

- [ ] **Step 1: Write the failing privacy-script self-test**

Create a temporary fixture containing a workers.dev URL, token-shaped value, API-key assignment, non-zero UUID, absolute user path, and persona/chat markers. Assert non-zero exit and output containing only file path, rule, and line number, never the matched value.

Run: node --test test/privacy-script.test.mjs

Expected: FAIL because scripts/privacy-scan.ps1 is missing.

- [ ] **Step 2: Implement four-surface privacy scanning**

Scan tracked files, every Git blob, extracted installer payload, and a new dry-run generated project. Detect provider tokens, secret assignments, production worker URLs, non-zero UUIDs, Windows user paths, non-example emails, private persona names, chat exports, image metadata, and forbidden private-project terms. Allow only reviewed generic third-party documentation names.

- [ ] **Step 3: Write architecture and release evidence**

Release checklist requires source/template tests, Electron smoke, dry-run, privacy scan, custom-path install, launch, uninstall, residue, SHA-256, disclaimer links, one real test-account deployment, HTTP 200 health, Telegram webhook success, resource list, cleanup instructions, and clean Git status. Never commit IDs, bot names, URLs, keys, prompt contents, or chat data.

- [ ] **Step 4: Run the complete local gate**

~~~powershell
npm ci
npm test
npm run package
npm run make
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-installer.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/privacy-scan.ps1
git diff --check
git status --short --branch
~~~

Expected: all commands exit 0, all tests pass, privacy scan has zero unreviewed findings, and Git is clean after the documentation commit.

- [ ] **Step 5: Perform test-account deployment acceptance**

Use disposable fictional bot/persona values and the authenticated Cloudflare session. Verify resource creation, migrations, model/thinking selection, secret upload, HTTP 200, Telegram webhook, resume after an induced recoverable failure, and cleanup. Never commit the generated project or acceptance secrets.

- [ ] **Step 6: Commit release gates**

~~~powershell
git add scripts/privacy-scan.ps1 docs README.md README_ZH.md test/privacy-script.test.mjs
git commit -m "docs: add verified privacy and release gates"
~~~

- [ ] **Step 7: Publication gate**

Create the public GitHub repository and release only after every check succeeds and the user approves the final repository name. Publish clean main, attach installer, portable archive, and SHA-256, then re-scan the remote repository. If any private value appears, immediately remove the affected release asset or repository content before further distribution.

---

## Plan Self-Review Record

- Spec coverage: GUI, model choice, thinking mode, privacy, resume, disclaimers, packaging, custom path, validation, and open-source delivery each map to a task.
- Security correction: secrets necessarily exist briefly in local password controls; they are cleared immediately and never persisted or echoed.
- Scope: one Windows product and one deployment core; no macOS, telemetry, accounts, auto-update, plugins, or arbitrary providers.
- Type consistency: model is one of two IDs; thinking normalizes to enabled or disabled; progress uses step, status, message, recoverable; resume never reads saved secrets.
- Placeholder scan: this plan contains no unfinished implementation markers or unspecified error-handling steps.
