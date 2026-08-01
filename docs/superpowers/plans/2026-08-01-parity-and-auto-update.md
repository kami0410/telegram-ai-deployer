# Bot Parity And Deployer Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Synchronize the private reference feature set into the generic deployer template and two existing generated bots, and add controlled automatic updates to the Windows deployer.

**Architecture:** Generic bot code is ported without persona data and applied through append-only D1 migrations. A testable Electron update controller wraps `electron-updater`; hardened IPC exposes status and user actions without exposing Node.js primitives.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, Queues, Vectorize, Electron, electron-builder, electron-updater, Node test runner.

## Global Constraints

- Preserve all project-specific personas, secrets, Cloudflare names, owner bindings, and remote data.
- Do not copy private persona content into reusable or public projects.
- Auto-update is packaged-build only, non-blocking, consent-based, and telemetry-free.
- Use append-only migrations `0008` through `0015`.

### Task 1: Automatic update controller

**Files:**
- Create: `lib/auto-update.mjs`
- Create: `test/auto-update.test.mjs`
- Modify: `app/main.mjs`
- Modify: `app/preload-api.mjs`
- Modify: `app/preload.cjs`
- Modify: `app/renderer/app.mjs`
- Modify: `app/renderer/index.html`
- Modify: `package.json`

- [ ] Write failing tests for packaged-only checking, consent-gated download/install, error handling, update IPC, and release metadata.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the smallest controller and hardened IPC surface that satisfies the tests.
- [ ] Run focused and full deployer tests.

### Task 2: Generic template parity

**Files:**
- Create/modify: `template/migrations/0008_*.sql` through `template/migrations/0015_realism_features.sql`
- Create/modify: relevant files under `template/src`, `template/config`, and `template/tools`
- Modify: template and privacy tests

- [ ] Add failing parity/privacy tests that require all migrations and forbid private identifiers.
- [ ] Port the genericized feature implementation.
- [ ] Run template typecheck, Wrangler types check, and deploy dry-run.

### Task 3: Existing generated-bot parity

**Files:**
- Create/modify: feature files in both existing generated-bot projects.

- [ ] Snapshot protected configuration and persona-file hashes.
- [ ] Apply generic feature code and migrations in place.
- [ ] Prove protected hashes/configuration remain unchanged.
- [ ] Run typecheck and deploy dry-run in both projects.

### Task 4: Remote migration and deployment

- [ ] Export each remote D1 database without reading message content.
- [ ] Apply pending migrations and deploy the first bot.
- [ ] Apply pending migrations and deploy the second bot.
- [ ] Verify both health endpoints and new schema tables.

### Task 5: Package and publish

- [ ] Run full deployer tests, audit, privacy scan, template validation, and installer build.
- [ ] Verify installer, ZIP, resources, runtime, uninstall, checksums, and auto-update metadata.
- [ ] Commit and push scoped changes.
- [ ] Publish a new GitHub release with installer, ZIP, checksums, `latest.yml`, and blockmap; verify it remotely.
