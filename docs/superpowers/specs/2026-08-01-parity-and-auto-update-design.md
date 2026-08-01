# Bot Parity And Deployer Auto-Update Design

## Goal

Bring the generic deployer template plus two existing generated bots to the same functional level as the private reference bot, while keeping every persona, secret, Cloudflare resource name, owner binding, and stored memory isolated. Add opt-in installation of deployer updates discovered automatically from public GitHub Releases.

## Project boundaries

- The private reference bot supplies feature behavior only; its persona content and private data never enter this repository.
- The bundled template receives generic `persona` terminology and becomes the source for future generated bots.
- Existing generated bots retain their own prompt files, `wrangler.jsonc`, secrets, resource identifiers, and remote D1 contents.
- Database changes are append-only migrations `0008` through `0015`; no existing table is dropped or rewritten.

## Generic feature port

Port the relationship state, reply feedback, memory controls, chat preferences, layered time memory, unfinished-topic follow-up, learned interaction preferences, realism controls, `/temp`, `/redo`, and relationship-timeline management features. Replace private identifiers and user-facing names with generic persona equivalents in the reusable template. Keep static persona seed files project-specific.

## Desktop auto-update

Use `electron-updater` with this public GitHub repository and the existing Windows NSIS target. Packaged builds check once after the main window opens and periodically while running. A found update is never installed silently: the user confirms download, then confirms restart/install. Network or GitHub failures remain non-blocking and do not affect deployment actions.

The renderer receives only frozen, narrowly-scoped update IPC methods and status events. The updater receives no bot secrets, generated-project paths, or deployment state. Development and smoke-test modes never contact the update provider.

GitHub releases must include the NSIS installer, `latest.yml`, and generated blockmap metadata. A minor version bump is used because this adds user-visible behavior and substantial generated-bot capabilities.

## Verification

- Test update state transitions and the preload/IPC allow-list before implementation.
- Run deployer tests, privacy scan, template typecheck, Wrangler type generation check, and deploy dry-run.
- For both existing generated bots, run typecheck and deploy dry-run before applying remote migrations and deployment.
- Verify both bot health endpoints without reading private chat content.
- Build the Windows installer and ZIP, verify installation/runtime/resources/uninstall, then publish and remotely verify release assets and metadata.
