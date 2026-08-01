export interface ChatPreferences {
  proactiveEnabled: boolean;
  dailyMin: number;
  dailyMax: number;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  pausedUntil: number | null;
  consecutiveUnanswered: number;
}

interface ChatPreferenceRow {
  proactive_enabled: number;
  daily_min: number;
  daily_max: number;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  paused_until: number | null;
  consecutive_unanswered: number;
}

const DEFAULTS: ChatPreferences = {
  proactiveEnabled: true,
  dailyMin: 2,
  dailyMax: 3,
  quietStartMinute: null,
  quietEndMinute: null,
  pausedUntil: null,
  consecutiveUnanswered: 0,
};

function fromRow(row: ChatPreferenceRow): ChatPreferences {
  return {
    proactiveEnabled: row.proactive_enabled === 1,
    dailyMin: row.daily_min,
    dailyMax: row.daily_max,
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    pausedUntil: row.paused_until,
    consecutiveUnanswered: row.consecutive_unanswered,
  };
}

export async function getChatPreferences(
  db: D1Database,
  ownerId: number,
): Promise<ChatPreferences> {
  const row = await db.prepare(
    `SELECT proactive_enabled, daily_min, daily_max, quiet_start_minute,
            quiet_end_minute, paused_until, consecutive_unanswered
     FROM owner_chat_preferences WHERE owner_id = ?`,
  ).bind(ownerId).first<ChatPreferenceRow>();
  return row === null ? { ...DEFAULTS } : fromRow(row);
}

export async function updateChatPreferences(
  db: D1Database,
  ownerId: number,
  input: Omit<ChatPreferences, "consecutiveUnanswered">,
  now: number,
): Promise<void> {
  if (
    !Number.isInteger(input.dailyMin) || !Number.isInteger(input.dailyMax) ||
    input.dailyMin < 1 || input.dailyMax > 3 || input.dailyMin > input.dailyMax
  ) throw new Error("chat_preferences_daily_range_invalid");
  const quietValid =
    (input.quietStartMinute === null && input.quietEndMinute === null) ||
    (Number.isInteger(input.quietStartMinute) && Number.isInteger(input.quietEndMinute) &&
      input.quietStartMinute! >= 0 && input.quietStartMinute! <= 1439 &&
      input.quietEndMinute! >= 0 && input.quietEndMinute! <= 1439);
  if (!quietValid) throw new Error("chat_preferences_quiet_invalid");
  const results = await db.batch([
    db.prepare(
      `INSERT INTO owner_chat_preferences (
         owner_id, proactive_enabled, daily_min, daily_max,
         quiet_start_minute, quiet_end_minute, paused_until, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         proactive_enabled = excluded.proactive_enabled,
         daily_min = excluded.daily_min, daily_max = excluded.daily_max,
         quiet_start_minute = excluded.quiet_start_minute,
         quiet_end_minute = excluded.quiet_end_minute,
         paused_until = excluded.paused_until, updated_at = excluded.updated_at`,
    ).bind(ownerId, input.proactiveEnabled ? 1 : 0, input.dailyMin, input.dailyMax,
      input.quietStartMinute, input.quietEndMinute, input.pausedUntil, now),
    db.prepare(
      `UPDATE persona_runtime_state SET week_start = NULL, next_proactive_at = NULL,
         updated_at = ? WHERE owner_id = ?`,
    ).bind(now, ownerId),
  ]);
  if (!results.every((result) => result.success)) throw new Error("chat_preferences_update_failed");
}

export async function isProactiveAllowedNow(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<boolean> {
  const preferences = await getChatPreferences(db, ownerId);
  if (!preferences.proactiveEnabled || (preferences.pausedUntil !== null && preferences.pausedUntil > now)) {
    return false;
  }
  if (preferences.quietStartMinute === null || preferences.quietEndMinute === null) return true;
  const beijingMinute = Math.floor((now + 8 * 3_600) % 86_400 / 60);
  const start = preferences.quietStartMinute;
  const end = preferences.quietEndMinute;
  const quiet = start === end || (start < end
    ? beijingMinute >= start && beijingMinute < end
    : beijingMinute >= start || beijingMinute < end);
  return !quiet;
}

async function ensureRow(db: D1Database, ownerId: number, now: number): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO owner_chat_preferences (owner_id, updated_at) VALUES (?, ?)`,
  ).bind(ownerId, now).run();
}

export async function noteProactiveSent(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<void> {
  await ensureRow(db, ownerId, now);
  await db.prepare(
    `UPDATE owner_chat_preferences
     SET consecutive_unanswered = MIN(10, consecutive_unanswered + 1), updated_at = ?
     WHERE owner_id = ?`,
  ).bind(now, ownerId).run();
}

export async function noteUserReply(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<void> {
  await ensureRow(db, ownerId, now);
  await db.prepare(
    `UPDATE owner_chat_preferences SET consecutive_unanswered = 0, updated_at = ?
     WHERE owner_id = ?`,
  ).bind(now, ownerId).run();
}
