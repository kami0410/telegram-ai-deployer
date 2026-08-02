import { handleRecoveryHttp } from "./recovery";
import { processQueueBatch } from "./queue";
import { handleScheduled } from "./scheduled";
import { handleWebhook } from "./webhook";
import { handleAppApi } from "./app-api";
import { renderAppPage, renderAppScript } from "./app-page";
import { renderTelegramBotAvatar } from "./telegram-avatar";
import { renderPublicPage } from "./public-page";
export { ReminderWorkflow } from "./reminder-workflow";

const HEALTH_RESPONSE = {
  ok: true,
  service: "persona-telegram-bot",
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return renderPublicPage();
    }

    if (url.pathname.startsWith("/api/app/")) {
      return handleAppApi(request, env);
    }

    if (request.method === "GET" && url.pathname === "/app") {
      return renderAppPage();
    }

    if (request.method === "GET" && url.pathname === "/app.js") {
      return renderAppScript();
    }

    if (request.method === "GET" && url.pathname === "/app/avatar") {
      return renderTelegramBotAvatar(env.TELEGRAM_BOT_TOKEN);
    }

    if (
      url.pathname === "/recover" ||
      url.pathname === "/api/recovery/setup" ||
      url.pathname === "/api/recovery/complete"
    ) {
      return handleRecoveryHttp(request, env.DB);
    }

    if (url.pathname === "/telegram/webhook") {
      return handleWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(HEALTH_RESPONSE);
    }

    return new Response("Not found", { status: 404 });
  },

  async queue(
    batch: MessageBatch,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await processQueueBatch(batch, env);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await handleScheduled(env);
  },
} satisfies ExportedHandler<Env>;
