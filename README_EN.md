<div align="right">

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README_EN.md)
[![中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-lightgrey.svg)](README.md)

</div>

# Cloudflare Telegram AI Bot Deployer

> [!IMPORTANT]
> This independent project is not affiliated with or endorsed by Cloudflare, Telegram, or DeepSeek. Before use, read [DISCLAIMER.md](DISCLAIMER.md), [PRIVACY.md](PRIVACY.md), and the third-party service terms and pricing.

A Windows visual wizard for deploying a private, text-only Telegram AI bot to a Cloudflare account. It creates the required Worker, D1 database, queues, Vectorize index, workflow, secrets, webhook, and health check.

The first release targets Windows 10/11 x64. DeepSeek V4 Flash is the default model; V4 Pro and an explicit thinking-mode toggle are also available.

## Network requirements

The wizard opens direct HTTPS connections from your computer to:

- `api.telegram.org` — bot token validation and webhook registration
- `api.deepseek.com` — API key validation
- Cloudflare service APIs — through the bundled Wrangler CLI

These connections **do not follow the Windows system proxy**. In regions where `api.telegram.org` is not directly reachable (for example, mainland China), the deployment stops at the `secrets` step with a "cannot connect to api.telegram.org" error. To fix this:

- **Recommended:** enable **TUN (global) mode** in your proxy client (Clash Verge, v2rayN, etc.) so traffic from every application is routed through the proxy, then retry the failed step.
- **Alternative:** close the app and relaunch it from a terminal with environment variables (the bundled Node.js 24 runtime honors them):

  ```powershell
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTPS_PROXY = "http://127.0.0.1:7897"  # adjust to your proxy port
  & "C:\path\to\Cloudflare Telegram AI Bot Deployer.exe"
  ```

## Security model

- Credentials are entered locally, cleared from the form after submission, and sent to Cloudflare through Wrangler secret input.
- Wrangler is bundled and version-pinned; the application never runs `npm`, `npx`, or a command resolved through `PATH`.
- Credentials, imported persona text, deployment state, generated projects, and logs are excluded from Git.
- The application loads local assets only and contains no telemetry.
- Review [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never post credentials or private prompts in a public issue.

## Status

The Windows application is under active development. Do not use pre-release builds for important or irreplaceable data.

Technical documentation: [User guide](docs/user-guide.md) · [Architecture](docs/architecture.md) · [Release checklist](docs/release-checklist.md)

License: [MIT](LICENSE)
