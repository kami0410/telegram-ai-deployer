import { isQueueJob, type QueueJob } from "./queue";
import { getOwner } from "./storage/owner-repository";
import { createTelegramClient } from "./telegram";

const ALERT_COOLDOWN_SECONDS = 6 * 3_600;

const KIND_LABELS: Record<QueueJob["type"], string> = {
  chat: "聊天回复",
  typing: "输入状态",
  bubble: "消息气泡",
  memory_update: "记忆更新",
  memory_vector_sync: "记忆向量同步",
  reminder_delivery: "提醒消息",
  weekly_review: "周报",
  persona_draft: "人格草稿",
  busy_resume: "恢复任务",
  proactive: "主动联系",
  ephemeral: "临时消息",
};

export interface DlqDependencies {
  fetcher?: typeof fetch;
}

/**
 * 死信队列消费：任务连续失败 3 次后进入 DLQ。
 * 这里做两件事：把终态写回数据库（用户消息可见、可追踪），
 * 并按类型节流地向主人发送 Telegram 告警。
 * 处理过程永不抛错，避免死信再次重试形成循环。
 */
export async function handleDlqBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  dependencies: DlqDependencies = {},
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleDlqMessage(message.body, env, dependencies);
    } catch {
      // 死信处理失败不再重试
    }
    message.ack();
  }
}

async function handleDlqMessage(
  body: unknown,
  env: Env,
  dependencies: DlqDependencies,
): Promise<void> {
  if (!isQueueJob(body)) return;
  const now = Math.floor(Date.now() / 1_000);
  switch (body.type) {
    case "chat":
      await env.DB.prepare(
        `UPDATE processed_updates
         SET status = 'failed', last_error_code = 'dlq_exhausted', updated_at = ?
         WHERE telegram_update_id = ? AND assistant_message_id IS NULL`,
      ).bind(now, body.telegramUpdateId).run();
      break;
    case "bubble":
    case "typing":
      await env.DB.prepare(
        `UPDATE deliveries
         SET status = 'failed', last_error_code = 'dlq_exhausted', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'sending')`,
      ).bind(now, body.deliveryId).run();
      break;
    default:
      break;
  }
  await alertDlq(env, body, now, dependencies);
}

async function alertDlq(
  env: Env,
  job: QueueJob,
  now: number,
  dependencies: DlqDependencies,
): Promise<void> {
  const key = `dlq_alert_v1:${job.type}`;
  const last = await env.DB.prepare(
    "SELECT value FROM bot_configuration WHERE key = ?",
  ).bind(key).first<{ value: string }>();
  const lastAt = Number(last?.value ?? 0);
  if (Number.isSafeInteger(lastAt) && lastAt > 0 && now - lastAt < ALERT_COOLDOWN_SECONDS) {
    return;
  }
  const owner = await getOwner(env.DB);
  if (owner === null) return;
  try {
    await createTelegramClient(
      env.TELEGRAM_BOT_TOKEN,
      dependencies.fetcher,
    ).sendMessage(
      owner.telegramChatId,
      `⚠️ 有一条${KIND_LABELS[job.type] ?? job.type}任务连续失败进入死信队列，已被标记为失败（dlq_exhausted）。`,
    );
  } catch {
    return;
  }
  await env.DB.prepare(
    `INSERT INTO bot_configuration (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, String(now), now).run();
}
