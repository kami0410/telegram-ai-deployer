import { secureEqualHex } from "./security";

const SESSION_SECONDS = 8 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u;

export const APP_SESSION_COOKIE = "persona_app_session";

interface SessionPayload {
  ownerId: number;
  telegramUserId: number;
  expiresAt: number;
  nonce: string;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function signature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`persona-app-session-v1:${payload}`),
  ));
}

export async function createAppSession(
  ownerId: number,
  telegramUserId: number,
  secret: string,
  now: number,
): Promise<string> {
  const payload = base64Url(JSON.stringify({
    ownerId,
    telegramUserId,
    expiresAt: now + SESSION_SECONDS,
    nonce: crypto.randomUUID(),
  } satisfies SessionPayload));
  return `${payload}.${await signature(payload, secret)}`;
}

export async function verifyAppSession(
  token: string,
  secret: string,
  now: number,
): Promise<SessionPayload | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [payload, provided] = token.split(".");
  if (payload === undefined || provided === undefined ||
    !secureEqualHex(provided, await signature(payload, secret))) return null;
  try {
    const value: unknown = JSON.parse(fromBase64Url(payload));
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<SessionPayload>;
    if (!Number.isSafeInteger(candidate.ownerId) || !Number.isSafeInteger(candidate.telegramUserId) ||
      !Number.isSafeInteger(candidate.expiresAt) || typeof candidate.nonce !== "string" ||
      (candidate.ownerId ?? 0) < 1 || (candidate.telegramUserId ?? 0) < 1 ||
      (candidate.expiresAt ?? 0) < now) return null;
    return candidate as SessionPayload;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${APP_SESSION_COOKIE}=${token}; Path=/api/app; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${APP_SESSION_COOKIE}=; Path=/api/app; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function cookieValue(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === APP_SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}
