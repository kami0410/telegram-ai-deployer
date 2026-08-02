# Privacy

The application has no analytics or advertising. It processes project settings, credentials, optional persona files, and deployment output locally. Credentials are sent only to the provider endpoints required to validate and deploy the user's bot. Persona content is placed only in the user's generated project and deployed Worker bundle.

Password controls are cleared immediately after submission. Secrets are passed to Wrangler through standard input, are not written to deployment state, and are redacted from application output. Non-secret resume state may contain project and resource names, selected model, completed steps, and a Worker URL.

Cloudflare, Telegram, DeepSeek, GitHub, and operating-system components process data under their own policies. Users are responsible for reviewing those policies and configuring retention, access, backup, and deletion.
