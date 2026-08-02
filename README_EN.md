<div align="right">

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README_EN.md)
[![中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-lightgrey.svg)](README.md)

</div>

# Cloudflare Telegram AI Bot Deployer

> [!IMPORTANT]
> This is an independent open-source project. It is not affiliated with, authorized by, sponsored by, or endorsed by Cloudflare, Telegram, or DeepSeek. Before use, read [DISCLAIMER.md](DISCLAIMER.md), [DISCLAIMER_ZH.md](DISCLAIMER_ZH.md), [PRIVACY.md](PRIVACY.md), and the applicable third-party terms and pricing.

A Windows visual wizard that deploys a private, text-only Telegram AI bot into your own Cloudflare account. It creates and configures the Worker, D1 database, message queues (including a dead-letter queue), Vectorize index, workflow (reminders), secrets, and the Telegram webhook, then runs a health check. The generated project is written to a local directory you choose and can later be managed with Wrangler or the built-in management panel.

## Features

- **Fully local visual wizard**: environment check and Cloudflare login, project setup, secret entry, disclaimer confirmation, and deployment in one flow. No separate Node.js or Wrangler installation is required (both are bundled).
- **Resumable deployment**: reopening the app after an interruption resumes from the last completed step; key steps are idempotent.
- **Privacy first**: credentials are entered locally, cleared immediately after submission, and written to Secrets only through Wrangler standard input. The app has no telemetry, no remote scripts, and loads local assets only.
- **Model selection**: DeepSeek V4 Flash (default, faster and cheaper) or V4 Pro; `/ask` always uses thinking mode.
- **Generated bot capabilities**: persona system (import or customize, `/persona-add`, `/persona-rollback`, version history and export), long-term memory (D1 + vector search + conflict confirmation), low-frequency proactive contact, weekly reviews, reminders and weekly reports, and a Telegram Web App management panel.

## Deployment fixes included

- **Persona file import did not respond**: the packaged Electron preload compatibility issue is fixed. **Choose file** now opens the Windows picker and imports `.txt`, `.md`, or `.json` persona prompts.
- **First deployment stopped at `workers.dev`**: new Cloudflare accounts that have not registered a `workers.dev` subdomain receive a clear instruction to complete that one-time Dashboard step and then resume deployment.
- **Final `health: fetch failed`**: health checks now retry. When a Worker was deployed but is temporarily unreachable, the app gives recovery guidance instead of treating existing resources as a failed deployment.

See the [first-use troubleshooting guide](docs/first-use-troubleshooting-zh.md) for the recovery steps.

## Recent template updates

- **v1.2.0**: the generated bot template is synced with the latest version: memory graph (`memory_graph`), identity core (`identity_core`), memory recall traces (`memory_recall_traces`), proactive decision records and quality event statistics; the management panel adds Relationship and Recall views; `/ask` always uses thinking mode (the obsolete thinking toggle is removed); a public status page and the Telegram bot avatar are included; six new D1 migrations (`0016`–`0021`); release quality evaluation and release gate tooling (`evaluate:realism` / `release:gate`).
- **v1.1.0 stable**: proactive contact now runs 2–3 times per Beijing day with at least four hours between contacts; a missing reply no longer blocks a later natural topic, while pending user messages take priority and delay proactive contact by one hour.
- **v1.0.0 stable**: long-term memories must be grounded in user-authored text; low-relevance memories are no longer injected automatically; malformed model responses are retried with a short fallback; historical failed jobs no longer block proactive contact; queue logs omit chat content; and generated projects include encrypted full-D1 backup and restore tools.
- **v0.1.7**: generated bots no longer emit parenthetical action/background narration such as “（动作）（背景）（环境）” or asterisk actions; they reply with direct speech only. Template tests now also support non-empty imported personas.
- **v0.1.6**: memory reliability fixes — overdue memory updates are recovered by the scheduler, memory-extraction failures are persisted, and updates trigger from the unsummarized-message backlog.
- **Memory hardening**: more tolerant memory JSON parsing and in-app episode memory management.

## Requirements

- Windows 10/11 x64.
- A Cloudflare account (the free plan works; check current quotas and pricing on the official pages).
- A Telegram bot token from BotFather.
- A DeepSeek API key.
- Network access to `api.telegram.org` (see “Network requirements” below).

## Quick start

1. Download the latest `Telegram.AI.Deployer-x.x.x-x64.exe` from the **Releases** page of this repository.
2. Run the installer and choose an installation directory (custom path supported; per-user install, no administrator rights required).
3. Launch the app and follow the wizard: environment check and Cloudflare login → project name and empty directory → the three secrets → read and accept the disclaimer → deploy.
4. After deployment, complete the Telegram pairing as prompted, then start chatting.
5. Send `/help` in the chat for all commands, or `/settings` to open the management panel.

After generation, run `npm.cmd run backup` in the bot project directory to create an encrypted full-D1 backup. The generated `BACKUP_ZH.md` documents the restore procedure.

See the [English user guide](docs/user-guide.md) or the [Chinese guide](docs/user-guide-zh.md) for full steps.

## Network requirements

The wizard opens direct HTTPS connections from your computer to:

- `api.telegram.org` — bot token validation and webhook registration
- `api.deepseek.com` — API key validation
- Cloudflare service APIs — through the bundled Wrangler CLI

These connections **do not follow the Windows system proxy**. In regions where `api.telegram.org` is not directly reachable (for example, mainland China), the deployment stops at the `secrets` step with a “cannot connect to api.telegram.org” error. To fix this:

- **Recommended:** enable **TUN (global) mode** in your proxy client (Clash Verge, v2rayN, etc.) so traffic from every application is routed through the proxy, then retry the failed step.
- **Alternative:** close the app and relaunch it from a terminal with environment variables (the bundled Node.js runtime honors them):

  ```powershell
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"  # adjust to your proxy port
  & "C:\path\to\Cloudflare Telegram AI Bot Deployer.exe"
  ```

## Security model

- Credentials are entered locally, cleared from the form after submission, and written to Cloudflare through Wrangler secret input.
- Wrangler is bundled and version-pinned; the application never runs `npm`, `npx`, or a command resolved through `PATH`.
- Credentials, imported persona text, deployment state, generated projects, and logs are excluded from Git.
- The application loads local assets only and contains no telemetry or remote scripts.
- Review [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never post credentials, tokens, or private prompts in a public issue.

## Privacy and disclaimer

By using the tool you confirm that you have read and accepted [DISCLAIMER.md](DISCLAIMER.md), [DISCLAIMER_ZH.md](DISCLAIMER_ZH.md), and [PRIVACY.md](PRIVACY.md). Deployment invokes third-party services (Cloudflare, Telegram, DeepSeek) and may incur charges. Generated bots store chat history and memories; set your own retention, backup, and deletion practices accordingly.

## Status and roadmap

- Current status: `v1.2.0` stable. The software is still provided without warranty; keep encrypted backups of important data.
- Roadmap: more management-panel features for generated bots, deeper deployment recovery and diagnostics, and more multilingual documentation.

## Documentation

- User guides: [English](docs/user-guide.md) · [中文](docs/user-guide-zh.md)
- First-use troubleshooting: `docs/first-use-troubleshooting-zh.md`
- Architecture: `docs/architecture.md` · Release checklist: `docs/release-checklist.md`
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- License: [MIT](LICENSE)
