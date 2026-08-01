import type { QueueJob, QueueSender, RandomSource } from "./queue";
import { createTelegramClient } from "./telegram";
import { releaseStaleReminderClaims } from "./storage/reminder-repository";
import {
  getChatPreferences,
  isProactiveAllowedNow,
} from "./storage/chat-preferences-repository";

const WEEK_SECONDS = 7 * 86_400;
const DAY_SECONDS = 86_400;
const MINIMUM_PROACTIVE_GAP = 4 * 3_600;
const BEIJING_OFFSET_SECONDS = 8 * 3_600;

const cryptoRandom: RandomSource = {
  nextUint32() {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  },
};

export interface ScheduledDependencies {
  queue?: QueueSender;
  fetcher?: typeof fetch;
  now?: () => number;
  random?: RandomSource;
}

export function weeklyReviewWindow(now: number): {
  weekKey: string;
  periodStart: number;
  periodEnd: number;
} | null {
  const local = new Date((now + BEIJING_OFFSET_SECONDS) * 1_000);
  if (local.getUTCDay() !== 0 || local.getUTCHours() < 21) return null;
  const periodEnd =
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate(),
      21,
    ) /
      1_000 -
    BEIJING_OFFSET_SECONDS;
  return {
    weekKey: new Date((periodEnd + BEIJING_OFFSET_SECONDS) * 1_000)
      .toISOString()
      .slice(0, 10),
    periodStart: periodEnd - WEEK_SECONDS,
    periodEnd,
  };
}

async function scheduleWeeklyReview(
  env: Env,
  dependencies: ScheduledDependencies,
  ownerId: number,
  now: number,
): Promise<void> {
  const window = weeklyReviewWindow(now);
  if (window === null) return;
  const reserved = await env.DB.prepare(
    `INSERT OR IGNORE INTO weekly_reviews (
       owner_id, week_key, period_start, period_end, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).bind(
    ownerId,
    window.weekKey,
    window.periodStart,
    window.periodEnd,
    now,
    now,
  ).run();
  if (reserved.meta.changes !== 1) {
    const retry = await env.DB.prepare(
      `UPDATE weekly_reviews SET updated_at = ?
       WHERE owner_id = ? AND week_key = ? AND status = 'queued'
         AND updated_at <= ?`,
    ).bind(now, ownerId, window.weekKey, now - 10 * 60).run();
    if (retry.meta.changes !== 1) return;
  }
  try {
    await queueSender(env, dependencies).send({
      type: "weekly_review",
      ownerId,
      weekKey: window.weekKey,
    });
  } catch (error) {
    if (reserved.meta.changes === 1) {
      await env.DB.prepare(
        `DELETE FROM weekly_reviews
         WHERE owner_id = ? AND week_key = ? AND status = 'queued'`,
      ).bind(ownerId, window.weekKey).run();
    }
    throw error;
  }
}

async function ensureTelegramManagementConfiguration(
  env: Env,
  dependencies: ScheduledDependencies,
  now: number,
): Promise<void> {
  const configured = await env.DB.prepare(
    "SELECT value FROM bot_configuration WHERE key = 'telegram_management_v1'",
  ).first<{ value: string }>();
  if (configured?.value === "configured") return;
  const baseUrl = new URL(env.PUBLIC_BASE_URL);
  const webhookUrl = new URL("/telegram/webhook", baseUrl).toString();
  const appUrl = new URL("/app", baseUrl).toString();
  await createTelegramClient(
    env.TELEGRAM_BOT_TOKEN,
    dependencies.fetcher,
  ).configureManagement({
    webhookUrl,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    appUrl,
  });
  await env.DB.prepare(
    `INSERT INTO bot_configuration (key, value, updated_at)
     VALUES ('telegram_management_v1', 'configured', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`,
  ).bind(now).run();
}

interface RuntimeScheduleRow {
  week_start: string | null;
  weekly_target: number;
  weekly_sent: number;
  last_proactive_at: number | null;
  next_proactive_at: number | null;
}

function randomInteger(
  minimum: number,
  maximum: number,
  random: RandomSource,
): number {
  const width = maximum - minimum + 1;
  return minimum + Math.floor((random.nextUint32() / 0x1_0000_0000) * width);
}

function beijingDayStartEpoch(now: number): number {
  return (
    Math.floor((now + BEIJING_OFFSET_SECONDS) / DAY_SECONDS) * DAY_SECONDS -
    BEIJING_OFFSET_SECONDS
  );
}

function dateKey(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString().slice(0, 10);
}

export function selectDailyTarget(
  random: RandomSource,
  minimum = 2,
  maximum = 3,
): number {
  return randomInteger(minimum, maximum, random);
}

export function calculateNextDailyProactiveAt(
  now: number,
  dayEnd: number,
  lastProactiveAt: number | null,
  random: RandomSource,
  remainingContacts = 1,
): number {
  const minimum = Math.max(
    now,
    lastProactiveAt === null ? now : lastProactiveAt + MINIMUM_PROACTIVE_GAP,
  );
  const latest = dayEnd - 1 - Math.max(0, remainingContacts - 1) * MINIMUM_PROACTIVE_GAP;
  return randomInteger(minimum, Math.max(minimum, latest), random);
}

async function cleanupExpired(db: D1Database, now: number): Promise<void> {
  const results = await db.batch([
    db.prepare("DELETE FROM persona_change_drafts WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM pending_confirmations WHERE expires_at < ?").bind(now),
    db
      .prepare(
        `DELETE FROM recovery_challenges
         WHERE expires_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM owner_recovery_events
             WHERE owner_recovery_events.challenge_id = recovery_challenges.id
           )`,
      )
      .bind(now),
  ]);
  if (!results.every((result) => result.success)) {
    throw new Error("scheduled_cleanup_failed");
  }
}

function queueSender(env: Env, dependencies: ScheduledDependencies): QueueSender {
  if (dependencies.queue !== undefined) return dependencies.queue;
  return {
    async send(job, options) {
      await env.MESSAGE_QUEUE.send(job, options);
    },
  };
}

async function scheduleOverdueMemoryUpdates(
  env: Env,
  dependencies: ScheduledDependencies,
  ownerId: number,
): Promise<void> {
  const threshold = Math.max(1, Number(env.MEMORY_UPDATE_INTERVAL) || 8) * 2;
  const conversations = await env.DB.prepare(
    `SELECT c.id
     FROM conversations c
     WHERE c.owner_id = ? AND c.status = 'active'
       AND (
         SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id AND m.mode = 'persona'
           AND m.id > COALESCE((
             SELECT MAX(s.through_message_id)
             FROM conversation_summaries s
             WHERE s.conversation_id = c.id
           ), 0)
       ) >= ?
     ORDER BY c.id
     LIMIT 3`,
  ).bind(ownerId, threshold).all<{ id: number }>();
  for (const conversation of conversations.results) {
    await queueSender(env, dependencies).send({
      type: "memory_update",
      ownerId,
      conversationId: conversation.id,
    });
  }
}

export async function handleScheduled(
  env: Env,
  dependencies: ScheduledDependencies = {},
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const random = dependencies.random ?? cryptoRandom;
  await cleanupExpired(env.DB, now);
  await recoverStaleReminderDeliveries(env, dependencies, now);
  await ensureTelegramManagementConfiguration(env, dependencies, now);

  const owner = await env.DB
    .prepare(
      `SELECT owners.id
       FROM owners
       JOIN persona_profiles ON persona_profiles.owner_id = owners.id
       WHERE persona_profiles.enabled = 1
         AND persona_profiles.consent_status = 'confirmed'
       ORDER BY owners.id LIMIT 1`,
    )
    .first<{ id: number }>();
  if (owner === null) return;

  await scheduleWeeklyReview(env, dependencies, owner.id, now);

  const pendingVectorJobs = await env.DB.prepare(
    `SELECT id FROM memory_vector_jobs
     WHERE owner_id = ? AND status IN ('pending', 'failed')
     ORDER BY updated_at, id LIMIT 10`,
  ).bind(owner.id).all<{ id: number }>();
  for (const _job of pendingVectorJobs.results) {
    await queueSender(env, dependencies).send({
      type: "memory_vector_sync",
      ownerId: owner.id,
    });
  }
  await scheduleOverdueMemoryUpdates(env, dependencies, owner.id);
  const preferences = await getChatPreferences(env.DB, owner.id);
  if (!(await isProactiveAllowedNow(env.DB, owner.id, now))) return;

  const dayStart = beijingDayStartEpoch(now);
  const dayEnd = dayStart + DAY_SECONDS;
  const dayKey = dateKey(dayStart + BEIJING_OFFSET_SECONDS);
  let schedule = await env.DB
    .prepare(
      `SELECT week_start, weekly_target, weekly_sent,
              last_proactive_at, next_proactive_at
       FROM persona_runtime_state WHERE owner_id = ?`,
    )
    .bind(owner.id)
    .first<RuntimeScheduleRow>();
  if (schedule === null || schedule.week_start !== dayKey) {
    const dailyTarget = preferences.consecutiveUnanswered >= 2
      ? 1
      : selectDailyTarget(random, preferences.dailyMin, preferences.dailyMax);
    const storedDailyTarget = dailyTarget - 1;
    const nextProactiveAt = calculateNextDailyProactiveAt(
      now,
      dayEnd,
      null,
      random,
      dailyTarget,
    );
    await env.DB
      .prepare(
        `INSERT INTO persona_runtime_state (
           owner_id, busy_until, next_proactive_at, week_start,
           weekly_target, weekly_sent, last_proactive_at, updated_at
         ) VALUES (?, NULL, ?, ?, ?, 0, NULL, ?)
         ON CONFLICT(owner_id) DO UPDATE SET
           next_proactive_at = excluded.next_proactive_at,
           week_start = excluded.week_start,
           weekly_target = excluded.weekly_target,
           weekly_sent = 0,
           last_proactive_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(owner.id, nextProactiveAt, dayKey, storedDailyTarget, now)
      .run();
    schedule = {
      week_start: dayKey,
      weekly_target: storedDailyTarget,
      weekly_sent: 0,
      last_proactive_at: null,
      next_proactive_at: nextProactiveAt,
    };
  }

  if (
    schedule.next_proactive_at === null ||
    schedule.next_proactive_at > now ||
    schedule.weekly_sent >= schedule.weekly_target + 1
  ) {
    return;
  }

  const pending = await env.DB
    .prepare(
      `SELECT COUNT(*) AS count
       FROM processed_updates
       WHERE owner_id = ?
          AND status IN ('received', 'queued', 'processing')`,
    )
    .bind(owner.id)
    .first<{ count: number }>();
  if ((pending?.count ?? 0) > 0) {
    const delayed = Math.min(dayEnd - 1, now + 3_600);
    await env.DB
      .prepare(
        `UPDATE persona_runtime_state
         SET next_proactive_at = ?, updated_at = ? WHERE owner_id = ?`,
      )
      .bind(delayed, now, owner.id)
      .run();
    return;
  }

  const sentAfter = schedule.weekly_sent + 1;
  const dailyTarget = schedule.weekly_target + 1;
  const remainingContacts = dailyTarget - sentAfter;
  const next =
    remainingContacts <= 0 || now + MINIMUM_PROACTIVE_GAP >= dayEnd
      ? null
      : calculateNextDailyProactiveAt(
          now,
          dayEnd,
          now,
          random,
          remainingContacts,
        );
  const reserved = await env.DB
    .prepare(
      `UPDATE persona_runtime_state
       SET weekly_sent = ?, last_proactive_at = ?, next_proactive_at = ?,
           updated_at = ?
       WHERE owner_id = ? AND next_proactive_at IS NOT NULL
         AND next_proactive_at <= ? AND weekly_sent = ?`,
    )
    .bind(sentAfter, now, next, now, owner.id, now, schedule.weekly_sent)
    .run();
  if (reserved.meta.changes !== 1) return;

  const job: QueueJob = { type: "proactive", ownerId: owner.id, scheduledAt: now };
  try {
    await queueSender(env, dependencies).send(job);
  } catch (error) {
    await env.DB
      .prepare(
        `UPDATE persona_runtime_state
         SET weekly_sent = ?, last_proactive_at = ?, next_proactive_at = ?,
             updated_at = ?
         WHERE owner_id = ? AND last_proactive_at = ?`,
      )
      .bind(
        schedule.weekly_sent,
        schedule.last_proactive_at,
        schedule.next_proactive_at,
        now,
        owner.id,
        now,
      )
      .run();
    throw error;
  }
}

export async function recoverStaleReminderDeliveries(
  env: Env,
  dependencies: ScheduledDependencies,
  now: number,
): Promise<number> {
  const stale = await releaseStaleReminderClaims(env.DB, now);
  let firstError: unknown = null;
  for (const reminder of stale) {
    try {
      await queueSender(env, dependencies).send({
        type: "reminder_delivery",
        reminderId: reminder.reminderId,
        ownerId: reminder.ownerId,
      });
    } catch (error) {
      await env.DB.prepare(
        `UPDATE reminders SET claimed_at = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'pending' AND claimed_at IS NULL`,
      ).bind(now - 10 * 60 - 1, now, reminder.reminderId, reminder.ownerId).run();
      firstError ??= error;
    }
  }
  if (firstError !== null) throw firstError;
  return stale.length;
}
