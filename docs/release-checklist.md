# Release checklist

Do not publish a repository or release while any required item remains unchecked. Never paste real tokens, account IDs, resource IDs, Worker URLs, bot usernames, persona text, or chat content into this document.

## Source and generated project

- [ ] Root Node test suite passes with zero failures.
- [ ] Template Cloudflare types are current.
- [ ] Template TypeScript typecheck passes.
- [ ] Template Worker test suite passes with zero failures.
- [ ] Wrangler dry-run bundles the template successfully.
- [ ] Fresh generation refuses non-empty output directories.
- [ ] Generated persona and deployment state are ignored by Git.
- [ ] `npm audit --omit=dev` reports zero production vulnerabilities in the desktop project and template.

## Desktop and package

- [ ] Electron development smoke reports `main-window-ready`.
- [ ] Bundled Wrangler smoke reports `deployment-runtime-ready` from the installed application.
- [ ] Renderer loads no remote scripts, fonts, frames, images, or analytics.
- [ ] Three secret controls use password inputs and clear synchronously after submission.
- [ ] Installer permits a custom per-user installation path.
- [ ] Installer contains the sanitized template and both disclaimers.
- [ ] Installed application launches from the selected path.
- [ ] Uninstaller completes and leaves no selected-path residue.
- [ ] Installer and ZIP are rebuilt from the release commit.
- [ ] `SHA256SUMS.txt` is regenerated after the final build.

## Privacy and legal

- [ ] `npm run privacy:scan` passes after the final commit and final package build.
- [ ] Working tree and complete Git history contain no personal identity, private persona, chat export, secret, production URL, account/resource ID, or user profile path.
- [ ] Extracted installer payload passes the same scan.
- [ ] Image assets, if any, have been inspected for metadata and private visual content.
- [ ] English and Chinese README files link prominently to the disclaimers and privacy notice.
- [ ] Application confirmation and About views open the bundled disclaimer as plain text.
- [ ] A qualified professional has reviewed the disclaimer if required for the intended distribution regions. This project does not provide legal advice.

## Isolated real-service acceptance

Use a disposable Telegram test bot and isolated Cloudflare resource prefix. Never repoint an existing production or personal bot webhook.

- [ ] Cloudflare OAuth/login completes from the packaged application.
- [ ] D1, two Queues, Vectorize indexes, Workflow, and Worker are created under the isolated prefix.
- [ ] D1 migrations apply remotely.
- [ ] Telegram and DeepSeek credentials validate without appearing in logs or state.
- [ ] Final Worker health endpoint returns HTTP 200.
- [ ] Telegram `setWebhook` succeeds with webhook-secret verification enabled.
- [ ] A text message receives a response using the selected model and thinking mode.
- [ ] Resume succeeds after an intentionally recoverable interruption and requires secrets again.
- [ ] Test bot webhook and every isolated Cloudflare resource are removed after acceptance.

## GitHub publication

- [ ] User has approved the exact public repository owner/name.
- [ ] Release branch is clean and based on the intended public history.
- [ ] Public repository is created without private templates, credentials, personal author metadata, or unrelated history.
- [ ] Installer, ZIP, and SHA-256 manifest are attached to the release.
- [ ] Remote default branch and release assets are downloaded or inspected and privacy-scanned again.
- [ ] Release notes disclose third-party requirements, costs, AI limitations, lack of code signing if applicable, and backup responsibilities.
- [ ] Cleanup and security-reporting instructions are visible.
