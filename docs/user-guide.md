[English](user-guide.md) · [中文](user-guide-zh.md)

# User Guide

A step-by-step walkthrough of the Cloudflare Telegram AI Bot Deployer, in the order you will actually use it.

> [!IMPORTANT]
> This is an independent open-source project, not affiliated with or endorsed by Cloudflare, Telegram, or DeepSeek. Deployment creates resources in **your own Cloudflare account**. Read [DISCLAIMER.md](../DISCLAIMER.md) and [PRIVACY.md](../PRIVACY.md) before use.

---

## 1. What this app does

It is a Windows desktop wizard that automatically creates and configures, inside your own Cloudflare account:

- a **Worker** (the bot backend, including scheduled tasks)
- a **D1 database** (chat history and configuration, with 6 schema migrations)
- a **queue pair** (main queue + dead-letter queue, for buffering and retries)
- a **Vectorize index** (semantic memory)
- a **Workflow** (reminders and weekly reviews)
- **Secrets** (your keys), the **Telegram webhook**, and a final health check

You only supply three credentials; everything else is automated.

## 2. Before you start

### 2.1 Required accounts and keys

| Item | How to get it | Cost |
|---|---|---|
| Cloudflare account | Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) | Free |
| Cloudflare Workers plan | No upgrade needed — the Free plan is enough | Queues has been on the Free plan since Feb 2026 (10,000 operations/day), and Workflows includes free quota (100,000 requests/day). Plenty for personal use. Note: free-tier queue messages are retained for 24 hours only |
| Telegram Bot Token | In Telegram, talk to [@BotFather](https://t.me/BotFather) → send `/newbot` → follow the prompts → you get a token like `123456:ABC-DEF...` | Free |
| DeepSeek API Key | [platform.deepseek.com](https://platform.deepseek.com) → API Keys → Create | Pay-as-you-go; top up a small amount first |

### 2.2 Network requirements (please read)

Deployment needs direct access to:

- `api.cloudflare.com` (Cloudflare API)
- `api.telegram.org` (Telegram Bot API)
- `api.deepseek.com` (DeepSeek API)

**Use the app only from a network environment where these services are reachable and where such access is lawful** (for example, when you are physically outside restricted regions, or via a compliant corporate international egress). This guide does not provide any method for circumventing network regulations.

Two technical facts, for users who already have a lawful network egress:

- The app's HTTP requests **do not follow the Windows system proxy** — they go direct. If your lawful egress is exposed as a system proxy, it must operate at the network layer (global/TUN mode) for the app's traffic to use it.
- You can also point the app at a specific egress via environment variables (supported by the bundled Node.js 24 runtime). Close the app, then in a terminal:
  ```powershell
  $env:NODE_USE_ENV_PROXY = "1"
  $env:HTTPS_PROXY = "http://your-egress-host:port"
  & "C:\path\to\Cloudflare Telegram AI Bot Deployer.exe"
  ```

### 2.3 A Windows 10/11 x64 machine

No Node.js, npm, or any other runtime is required — everything is bundled.

## 3. Installation

Download the latest release from [Releases](https://github.com/kami0410/telegram-ai-deployer/releases):

- **`Telegram.AI.Deployer-x.x.x-x64.exe`** — installer. Double-click → choose an install directory → desktop and Start Menu shortcuts are created. No administrator rights needed (per-user install).
- **`Telegram.AI.Deployer-x.x.x-x64.zip`** — portable build. Extract anywhere and run the exe inside.

> Recommended: verify the SHA256 checksums published on the release page (PowerShell: `Get-FileHash <file> -Algorithm SHA256`).

## 4. The wizard, step by step

### Step 1: Environment check

Click **"检查并连接" (Check & connect)**.

- If you have never logged in to Cloudflare on this machine, a browser window opens for Cloudflare authorization — sign in and click **Allow** (this authorizes the Wrangler CLI; credentials stay in your local user profile).
- When it shows **"Cloudflare 已连接" (connected)**, click Next.
- If authorization keeps failing, use an API token instead: Cloudflare dashboard → My Profile → API Tokens → create one from the "Edit Cloudflare Workers" template, set it as the `CLOUDFLARE_API_TOKEN` system environment variable, then restart the app and re-check.

### Step 2: Persona file (optional)

Pick a persona prompt file (`.txt` / `.md` / `.json`, up to 100,000 characters). The bot's speaking style will be based on it.

- Skipping is fine — a generic persona is used, and you can swap it later.
- The file is read locally and written only into your private Worker. It is **never uploaded to any third party** (beyond your own Cloudflare deployment).

### Step 3: Configuration

| Field | Meaning |
|---|---|
| Model | **V4 Flash** (default — faster and cheaper) or **V4 Pro** (higher quality on complex tasks) |
| Thinking mode | Toggle; slower answers but deeper reasoning |
| Project name | 2–40 safe characters starting with a letter (letters/digits/hyphens). Used as the Worker name and the prefix for every resource |
| New/empty project directory | Where the generated bot project is written. **Must be a new or empty directory**, absolute path (e.g. `C:\Bots\my-bot`) |
| Telegram Bot Token | The one from BotFather |
| DeepSeek API Key | The one from the DeepSeek platform |
| Pairing/migration key | **Make up an 8–32 character secret.** This is your credential as the bot's owner — remember it |

> After submission the form is wiped immediately. Keys travel only through encrypted channels into your Cloudflare Worker secrets and are never written to project files.

### Step 4: Accept the disclaimer and deploy

Tick "I have read and accept the disclaimer…" (full text available via the link), then click **"开始部署" (Deploy)**.

Deployment runs 11 steps with a redacted live log, usually 2–5 minutes:

1. **environment** — verify Cloudflare login state
2. **template** — generate the bot project locally
3. **d1** — create the D1 database
4. **queues** — create the main and dead-letter queues
5. **vectorize** — create the vector index and metadata indexes
6. **migration** — apply 6 database migrations
7. **first-deploy** — upload and activate the Worker
8. **secrets** — validate the Telegram token and DeepSeek key, then write secrets
9. **final-deploy** — redeploy with the real public URL
10. **webhook** — register the callback with Telegram
11. **health** — final health check

All green means done.

### Step 5: Start using the bot

1. Open your bot in Telegram and send: `/pair <your pairing key>`
2. Once paired, just chat.
3. To change the persona or configuration later, run the wizard again with the same project name — existing resources are reused.

## 5. Interrupted deployments and recovery

Progress is saved to `deployment-state.json` in your chosen project directory.

- If any step fails, the app shows the exact reason and the **"恢复部署" (Resume)** button becomes available.
- After fixing the problem, click Resume — deployment **continues from the failed step**; completed resources are not recreated.
- Note: you must re-enter the three credentials when resuming (they are never stored on disk, by design).

## 6. FAQ

**Q: Environment check never shows "connected"?**
A: Make sure you completed the Cloudflare authorization in the browser, or use the `CLOUDFLARE_API_TOKEN` environment variable method (see Step 1).

**Q: The secrets step fails with "cannot connect to api.telegram.org"?**
A: Your current network cannot reach the Telegram Bot API directly. Use a lawful network environment where it is reachable (see §2.2), then click Resume — finished steps won't run again.

**Q: "Telegram token is invalid"?**
A: This time the connection worked but the token didn't. Check that you copied it completely, with no extra spaces or line breaks — or regenerate it in BotFather with `/token`.

**Q: "DeepSeek key is invalid (HTTP 401/402)"?**
A: Wrong key or insufficient balance. Check the DeepSeek platform.

**Q: Is the free plan's quota enough?**
A: For personal use, easily. The free plan includes per day: 100k Worker requests, 10k Queues operations, 100k Workflows requests, 5M D1 rows read. The only real difference is that free-tier queue messages are retained for 24 hours (vs 14 days on paid), which doesn't matter for a chat bot. Upgrade to Workers Paid later only if you actually outgrow it.

**Q: Can I deploy multiple bots?**
A: Yes. Give each bot a distinct **project name** and its own **empty directory** — resources are fully isolated.

**Q: Will deployment touch my other Cloudflare projects?**
A: No. Every resource name is prefixed with your project name; the app only creates or reuses its own set.

## 7. Compliance and privacy notes

- Use this software and the Telegram, Cloudflare, and DeepSeek services only within the bounds of the laws of your jurisdiction, and follow each platform's terms of service.
- Do not import other people's private information or any unlawful content into the persona file. You, as the deployer, are responsible for what the bot outputs.
- The app contains no telemetry and loads no remote pages. Keys live only in your Cloudflare Worker secrets.
- Uninstalling the app does not remove cloud resources. To clean up completely, delete the corresponding Worker, D1 database, queues, and Vectorize index in the Cloudflare dashboard.
