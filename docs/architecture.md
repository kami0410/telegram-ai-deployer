# Architecture

## Trust boundaries

The application has four explicit boundaries:

1. The Electron Renderer displays the five-step wizard. It has no Node.js access, no remote content, no network permission, and receives only a frozen, narrow API from Preload.
2. Electron Main validates IPC requests, clears copied secrets after each deployment attempt, and starts only the current application executable in Electron's Node mode.
3. The deployment core validates inputs, generates a fresh private project, invokes the bundled and version-pinned Wrangler CLI with argument arrays and `shell: false`, redacts streamed output, and persists only non-secret resume state.
4. Cloudflare, Telegram, and DeepSeek remain independent third parties. Their authentication, terms, billing, availability, and data handling are outside this project's control.

The application never invokes `npm`, `npx`, PowerShell, or an executable discovered through `PATH`. Wrangler `4.114.0` and its production dependencies are bundled in the signed application payload. The application executable is reused as the trusted Node runtime with `ELECTRON_RUN_AS_NODE=1`; a local wrapper normalizes Electron argument semantics before loading Wrangler.

## Deployment flow

The state machine executes these idempotent or resumable steps:

1. verify Cloudflare authentication;
2. copy the sanitized template into a new or empty directory;
3. create or resolve D1;
4. create missing Queues using exact-name comparison;
5. create Vectorize and metadata indexes;
6. apply D1 migrations;
7. perform the initial Worker deployment;
8. validate Telegram and DeepSeek credentials and write Worker secrets through standard input;
9. deploy the final configuration;
10. register the Telegram webhook with a random webhook secret;
11. verify the Worker health endpoint.

After each successful step, `deployment-state.json` stores only the project name, output directory, model choice, thinking choice, completed steps, Cloudflare resource references, Worker URL, and timestamp. Telegram tokens, DeepSeek keys, migration keys, webhook secrets, persona text, and chat data are never written to that state file. Resume requires all three user secrets to be entered again.

## Generated project

`template/` is a generic, sanitized Cloudflare Worker project. A user-selected TXT, Markdown, or JSON persona file is read locally and serialized into `src/persona/imported-prompt.ts` inside the generated private project. The generated `.gitignore` excludes that file and the deployment state. Fresh generation refuses a non-empty output directory, preventing accidental overwrite and preventing execution of pre-existing package lifecycle scripts.

The Worker template provides Telegram text chat, DeepSeek model selection, bounded output, D1 conversation state, Vectorize semantic memory, Queues, Workflows, reminders, persona draft controls, ownership pairing, webhook verification, and recovery/export mechanisms. Users remain responsible for consent, lawful use, backups, and third-party costs.

## Desktop security

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and `webSecurity: true`.
- Local HTML, CSS, and JavaScript only; Content Security Policy blocks remote scripts, frames, plugins, form submission, and renderer network access.
- Navigation and new windows are denied.
- Preload exposes only environment check, persona selection, deployment, resume, cancellation status, output-folder opening, local notices, and sanitized progress events.
- All process execution uses the exact current executable path; basename or `PATH` matches are rejected.
- Process arguments are arrays and the shell is disabled. Secrets for Wrangler are supplied through standard input.
- Logs are redacted before they cross into the Renderer.

## Packaging

Electron Builder creates a per-user Windows x64 NSIS installer and ZIP archive. NSIS is configured as an assisted installer so the user can select the installation directory. Application code and bundled Wrangler are stored in ASAR; the sanitized template and two disclaimers are copied as external read-only resources because the deployment core reads them through filesystem APIs.

The installer verification script installs to a unique custom path below the Windows temporary directory, checks the packaged resources, starts the packaged Wrangler runtime and requires `deployment-runtime-ready`, checks application startup, uninstalls, verifies no custom-path residue, and writes a SHA-256 manifest.

## Privacy release gate

The privacy gate scans tracked/untracked source, every Git commit, a newly generated test project, and extracted packaged content. It never prints matched secret values. Releases must additionally be checked for environment files, deployment state, private prompts, chat exports, provider keys, Telegram tokens, production Worker URLs, real identifiers, user profile paths, non-example contact information, and unintended image metadata.

See [release-checklist.md](release-checklist.md) for the evidence required before publishing.
