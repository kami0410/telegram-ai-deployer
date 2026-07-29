import { renderRecoveryPage } from "./recovery-page";
import {
  completeRecovery,
  getActiveRecoveryChallenge,
  setupRecoveryKey,
} from "./storage/recovery-repository";

const MAX_BODY_BYTES = 4 * 1_024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

class BodyTooLargeError extends Error {}

function genericError(status = 400): Response {
  return Response.json(
    { ok: false, error: "验证失败或链接已失效" },
    { status, headers: COMMON_HEADERS },
  );
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > MAX_BODY_BYTES
  ) {
    throw new BodyTooLargeError("body_too_large");
  }

  if (request.body === null) throw new Error("missing_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError("body_too_large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function nextProactiveAt(now: number): number {
  const minimum = 48 * 60 * 60;
  const extraWindow = 5 * 24 * 60 * 60;
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return now + minimum + (random % (extraWindow + 1));
}

export async function handleRecoveryHttp(
  request: Request,
  db: D1Database,
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/recover") {
    const challengeId = url.searchParams.get("challenge");
    if (challengeId === null || !UUID.test(challengeId)) {
      return genericError(404);
    }

    const challenge = await getActiveRecoveryChallenge(db, challengeId, now);
    if (challenge === null) return genericError(404);
    const page = renderRecoveryPage({
      challengeId,
      purpose: challenge.purpose,
      nonce: randomNonce(),
    });
    return new Response(page.body, { status: 200, headers: page.headers });
  }

  if (
    request.method !== "POST" ||
    (url.pathname !== "/api/recovery/setup" &&
      url.pathname !== "/api/recovery/complete")
  ) {
    return genericError(404);
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(request);
  } catch (error) {
    return genericError(error instanceof BodyTooLargeError ? 413 : 400);
  }
  if (!isObject(payload)) return genericError();

  const challengeId = payload.challengeId;
  const newKeyHash = payload.newKeyHash;
  if (
    typeof challengeId !== "string" ||
    !UUID.test(challengeId) ||
    typeof newKeyHash !== "string" ||
    !SHA256_HEX.test(newKeyHash)
  ) {
    return genericError();
  }

  if (url.pathname === "/api/recovery/setup") {
    const result = await setupRecoveryKey(db, {
      challengeId,
      newKeyHash,
      now,
    });
    return result.ok
      ? Response.json({ ok: true }, { headers: COMMON_HEADERS })
      : genericError();
  }

  if (typeof payload.oldKey !== "string" || payload.oldKey.length > 64) {
    return genericError();
  }
  const result = await completeRecovery(db, {
    challengeId,
    oldKey: payload.oldKey,
    newKeyHash,
    now,
    nextProactiveAt: nextProactiveAt(now),
  });
  return result.ok
    ? Response.json({ ok: true }, { headers: COMMON_HEADERS })
    : genericError(result.reason === "rate_limited" ? 429 : 400);
}
