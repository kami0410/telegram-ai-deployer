const DEFAULT_MAX_AGE_SECONDS = 15 * 60;
const MAX_FUTURE_SKEW_SECONDS = 30;
const MAX_INIT_DATA_BYTES = 8 * 1_024;

export interface VerifiedTelegramUser {
  userId: number;
  chatId: number;
  authDate: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/iu.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function hmacSha256(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

function parseJsonRecord(value: string | null, errorCode: string): Record<string, unknown> {
  if (value === null) throw new Error(errorCode);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) throw new Error(errorCode);
    return parsed;
  } catch {
    throw new Error(errorCode);
  }
}

export async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  now: number,
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
): Promise<VerifiedTelegramUser> {
  if (
    new TextEncoder().encode(initData).byteLength > MAX_INIT_DATA_BYTES ||
    botToken.length === 0 ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds <= 0
  ) {
    throw new Error("init_data_invalid");
  }
  const params = new URLSearchParams(initData);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) throw new Error("init_data_duplicate_field");
    seen.add(key);
  }
  const providedHash = fromHex(params.get("hash") ?? "");
  if (providedHash === null) throw new Error("init_data_signature_invalid");

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const calculatedHash = new Uint8Array(await hmacSha256(secret, dataCheckString));
  if (!equalBytes(providedHash, calculatedHash)) {
    throw new Error("init_data_signature_invalid");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate)) throw new Error("init_data_auth_date_invalid");
  if (authDate < now - maxAgeSeconds || authDate > now + MAX_FUTURE_SKEW_SECONDS) {
    throw new Error("init_data_expired");
  }

  const user = parseJsonRecord(params.get("user"), "init_data_user_invalid");
  if (!safeInteger(user.id) || user.id <= 0) throw new Error("init_data_user_invalid");

  const chatValue = params.get("chat");
  let chatId = user.id;
  if (chatValue !== null) {
    const chat = parseJsonRecord(chatValue, "init_data_chat_invalid");
    if (!safeInteger(chat.id) || chat.type !== "private") {
      throw new Error("init_data_chat_invalid");
    }
    chatId = chat.id;
  }
  return { userId: user.id, chatId, authDate };
}
