# Cloudflare Telegram AI Bot Deployer

> [!IMPORTANT]
> This independent project is not affiliated with or endorsed by Cloudflare, Telegram, or DeepSeek. Before use, read [DISCLAIMER.md](DISCLAIMER.md), [PRIVACY.md](PRIVACY.md), and the third-party service terms and pricing.

A Windows visual wizard for deploying a private, text-only Telegram AI bot to a Cloudflare account. It creates the required Worker, D1 database, queues, Vectorize index, workflow, secrets, webhook, and health check.

The first release targets Windows 10/11 x64. DeepSeek V4 Flash is the default model; V4 Pro and an explicit thinking-mode toggle are also available.

## Security model

- Credentials are entered locally, cleared from the form after submission, and sent to Cloudflare through Wrangler secret input.
- Credentials, imported persona text, deployment state, generated projects, and logs are excluded from Git.
- The application loads local assets only and contains no telemetry.
- Review [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never post credentials or private prompts in a public issue.

## Status

The Windows application is under active development. Do not use pre-release builds for important or irreplaceable data.

Chinese documentation: [README_ZH.md](README_ZH.md)

License: [MIT](LICENSE)
