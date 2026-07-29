const BEIJING_OFFSET_SECONDS = 8 * 3_600;

export interface ParsedReminderRequest {
  dueAt: number;
  content: string;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatBeijingTime(epochSeconds: number): string {
  const date = new Date((epochSeconds + BEIJING_OFFSET_SECONDS) * 1_000);
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}

function beijingParts(epochSeconds: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const date = new Date((epochSeconds + BEIJING_OFFSET_SECONDS) * 1_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function toEpoch(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): number | null {
  const milliseconds =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    BEIJING_OFFSET_SECONDS * 1_000;
  const roundTrip = beijingParts(milliseconds / 1_000);
  return Object.entries(parts).every(
    ([key, value]) => roundTrip[key as keyof typeof roundTrip] === value,
  )
    ? milliseconds / 1_000
    : null;
}

function chineseNumber(value: string): number | null {
  if (/^\d{1,2}$/u.test(value)) return Number(value);
  const digit: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  const ten = value.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : digit[value[0] ?? ""];
    const ones = ten === value.length - 1 ? 0 : digit[value.at(-1) ?? ""];
    return tens === undefined || ones === undefined ? null : tens * 10 + ones;
  }
  return digit[value] ?? null;
}

function normalizeContent(value: string): string {
  return value
    .replace(/^\s*(?:提醒我|提醒一下我|提醒一下|记得叫我|叫我)\s*/u, "")
    .replace(/^[，,。:：\s]+/u, "")
    .trim();
}

export function parseReminderRequest(
  raw: string,
  now: number,
): ParsedReminderRequest | null {
  const input = raw.trim();
  const explicit = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2})(?::(\d{1,2}))?\s+([\s\S]+)$/u.exec(input);
  if (explicit !== null) {
    const dueAt = toEpoch({
      year: Number(explicit[1]),
      month: Number(explicit[2]),
      day: Number(explicit[3]),
      hour: Number(explicit[4]),
      minute: Number(explicit[5] ?? 0),
    });
    const content = normalizeContent(explicit[6] ?? "");
    return dueAt !== null && dueAt > now && content.length > 0 && content.length <= 500
      ? { dueAt, content }
      : null;
  }

  const match = /^(?:(今天|明天|后天)\s*)?(早上|上午|中午|下午|晚上|今晚|明晚)?\s*([零一二两三四五六七八九十\d]{1,3})点(?:(半)|([零一二两三四五六七八九十\d]{1,3})分?)?\s*([\s\S]+)$/u.exec(input);
  if (match === null) return null;
  const nowParts = beijingParts(now);
  const dayToken = match[1] ?? "";
  const period = match[2] ?? "";
  const rawHour = chineseNumber(match[3] ?? "");
  const rawMinute = match[4] === "半" ? 30 : chineseNumber(match[5] ?? "零");
  if (rawHour === null || rawMinute === null || rawHour > 23 || rawMinute > 59) {
    return null;
  }
  let hour = rawHour;
  if ((period === "下午" || period === "晚上" || period === "今晚" || period === "明晚") && hour < 12) {
    hour += 12;
  } else if (period === "中午" && hour < 11) {
    hour += 12;
  } else if ((period === "早上" || period === "上午") && hour === 12) {
    hour = 0;
  }
  let dayOffset = dayToken === "后天" ? 2 : dayToken === "明天" || period === "明晚" ? 1 : 0;
  const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dayOffset));
  let dueAt = toEpoch({
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    hour,
    minute: rawMinute,
  });
  if (dueAt !== null && dueAt <= now && dayToken.length === 0 && period !== "明晚") {
    dayOffset += 1;
    const next = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dayOffset));
    dueAt = toEpoch({
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour,
      minute: rawMinute,
    });
  }
  const content = normalizeContent(match[6] ?? "");
  return dueAt !== null && dueAt > now && content.length > 0 && content.length <= 500
    ? { dueAt, content }
    : null;
}
