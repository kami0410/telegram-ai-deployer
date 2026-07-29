import { hashRecoveryKey } from "../recovery-key";
import { randomId, secureEqualHex, sha256Hex } from "../security";

const CHALLENGE_LIFETIME_SECONDS = 10 * 60;
const MAX_DAILY_CHALLENGES = 5;
const MAX_CHALLENGE_ATTEMPTS = 5;
const MAX_DAILY_FAILURES = 10;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ChallengeFailureReason =
  | "not_owner"
  | "recovery_not_configured"
  | "rate_limited";

export type ChallengeResult =
  | { ok: true; challengeId: string; expiresAt: number }
  | { ok: false; reason: ChallengeFailureReason };

export type RecoveryMutationResult =
  | { ok: true; ownerId: number; keyVersion: number }
  | { ok: false; reason: "invalid_or_expired" | "rate_limited" };

export interface RecoveryChallenge {
  challengeId: string;
  purpose: "setup" | "recover";
  ownerId: number;
  requestedUserId: number;
  requestedChatId: number;
  attempts: number;
  expiresAt: number;
}

interface OwnerIdentityRow {
  id: number;
  telegram_user_id: number;
  telegram_chat_id: number;
}

interface ChallengeRow {
  id: string;
  purpose: "setup" | "recover";
  owner_id: number;
  requested_user_id: number;
  requested_chat_id: number;
  attempts: number;
  expires_at: number;
}

interface RecoveryContextRow extends ChallengeRow {
  key_hash: string;
  key_version: number;
  old_user_id: number;
  old_chat_id: number;
}

interface CountRow {
  challenge_count: number;
  failure_count: number;
}

function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString().slice(0, 10);
}

function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

async function requesterHash(
  telegramUserId: number,
  telegramChatId: number,
): Promise<string> {
  return sha256Hex(`${telegramUserId}:${telegramChatId}`);
}

function changes(result: D1Result | undefined): number {
  return result?.meta.changes ?? -1;
}

function batchSucceeded(results: D1Result[]): boolean {
  return results.every((result) => result.success);
}

function toChallenge(row: ChallengeRow): RecoveryChallenge {
  return {
    challengeId: row.id,
    purpose: row.purpose,
    ownerId: row.owner_id,
    requestedUserId: row.requested_user_id,
    requestedChatId: row.requested_chat_id,
    attempts: row.attempts,
    expiresAt: row.expires_at,
  };
}

export async function getActiveRecoveryChallenge(
  db: D1Database,
  challengeId: string,
  now: number,
): Promise<RecoveryChallenge | null> {
  const row = await db
    .prepare(
      `SELECT id, purpose, owner_id, requested_user_id, requested_chat_id,
              attempts, expires_at
       FROM recovery_challenges
       WHERE id = ?
         AND owner_id IS NOT NULL
         AND consumed_at IS NULL
         AND expires_at >= ?
         AND attempts < ?`,
    )
    .bind(challengeId, now, MAX_CHALLENGE_ATTEMPTS)
    .first<ChallengeRow>();

  return row === null ? null : toChallenge(row);
}

export async function createSetupChallenge(
  db: D1Database,
  telegramUserId: number,
  telegramChatId: number,
  now: number,
): Promise<ChallengeResult> {
  const owner = await db
    .prepare(
      `SELECT id, telegram_user_id, telegram_chat_id
       FROM owners
       ORDER BY id
       LIMIT 1`,
    )
    .first<OwnerIdentityRow>();

  if (
    owner === null ||
    owner.telegram_user_id !== telegramUserId ||
    owner.telegram_chat_id !== telegramChatId
  ) {
    return { ok: false, reason: "not_owner" };
  }

  const challengeId = randomId();
  const expiresAt = now + CHALLENGE_LIFETIME_SECONDS;
  await db
    .prepare(
      `INSERT INTO recovery_challenges (
         id, purpose, owner_id, requested_user_id, requested_chat_id,
         expires_at, created_at
       ) VALUES (?, 'setup', ?, ?, ?, ?, ?)`,
    )
    .bind(
      challengeId,
      owner.id,
      telegramUserId,
      telegramChatId,
      expiresAt,
      now,
    )
    .run();

  return { ok: true, challengeId, expiresAt };
}

export async function createRecoveryChallenge(
  db: D1Database,
  telegramUserId: number,
  telegramChatId: number,
  now: number,
): Promise<ChallengeResult> {
  const hash = await requesterHash(telegramUserId, telegramChatId);
  const usageDate = utcDate(now);
  const rate = await db
    .prepare(
      `INSERT INTO recovery_rate_limits (
         requester_hash, usage_date, challenge_count, failure_count
       ) VALUES (?, ?, 1, 0)
       ON CONFLICT(requester_hash, usage_date) DO UPDATE SET
         challenge_count = challenge_count + 1
       WHERE challenge_count < ? AND failure_count < ?
       RETURNING challenge_count, failure_count`,
    )
    .bind(hash, usageDate, MAX_DAILY_CHALLENGES, MAX_DAILY_FAILURES)
    .first<CountRow>();

  if (rate === null) return { ok: false, reason: "rate_limited" };

  const owner = await db
    .prepare(
      `SELECT owners.id, owners.telegram_user_id, owners.telegram_chat_id
       FROM owners
       JOIN owner_recovery ON owner_recovery.owner_id = owners.id
       ORDER BY owners.id
       LIMIT 1`,
    )
    .first<OwnerIdentityRow>();

  if (owner === null) {
    return { ok: false, reason: "recovery_not_configured" };
  }

  const challengeId = randomId();
  const expiresAt = now + CHALLENGE_LIFETIME_SECONDS;
  await db
    .prepare(
      `INSERT INTO recovery_challenges (
         id, purpose, owner_id, requested_user_id, requested_chat_id,
         expires_at, created_at
       ) VALUES (?, 'recover', ?, ?, ?, ?, ?)`,
    )
    .bind(
      challengeId,
      owner.id,
      telegramUserId,
      telegramChatId,
      expiresAt,
      now,
    )
    .run();

  return { ok: true, challengeId, expiresAt };
}

export interface SetupRecoveryKeyInput {
  challengeId: string;
  newKeyHash: string;
  now: number;
}

export async function setupRecoveryKey(
  db: D1Database,
  input: SetupRecoveryKeyInput,
): Promise<RecoveryMutationResult> {
  if (!isSha256Hex(input.newKeyHash)) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const challenge = await getActiveRecoveryChallenge(
    db,
    input.challengeId,
    input.now,
  );
  if (challenge === null || challenge.purpose !== "setup") {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const current = await db
    .prepare(
      "SELECT key_version FROM owner_recovery WHERE owner_id = ?",
    )
    .bind(challenge.ownerId)
    .first<{ key_version: number }>();
  const keyVersion = (current?.key_version ?? 0) + 1;

  const activeSetup = `EXISTS (
    SELECT 1 FROM recovery_challenges
    WHERE id = ? AND purpose = 'setup' AND owner_id = ?
      AND consumed_at IS NULL AND expires_at >= ? AND attempts < ?
  )`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO owner_recovery (owner_id, key_hash, key_version, created_at)
         SELECT ?, ?, ?, ? WHERE ${activeSetup}
         ON CONFLICT(owner_id) DO UPDATE SET
           key_hash = excluded.key_hash,
           key_version = excluded.key_version,
           created_at = excluded.created_at`,
      )
      .bind(
        challenge.ownerId,
        input.newKeyHash,
        keyVersion,
        input.now,
        input.challengeId,
        challenge.ownerId,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `UPDATE recovery_challenges
         SET consumed_at = ?
         WHERE owner_id = ? AND id <> ? AND consumed_at IS NULL
           AND ${activeSetup}`,
      )
      .bind(
        input.now,
        challenge.ownerId,
        input.challengeId,
        input.challengeId,
        challenge.ownerId,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `UPDATE recovery_challenges
         SET consumed_at = ?
         WHERE id = ? AND purpose = 'setup' AND owner_id = ?
           AND consumed_at IS NULL AND expires_at >= ? AND attempts < ?`,
      )
      .bind(
        input.now,
        input.challengeId,
        challenge.ownerId,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
  ]);

  if (
    !batchSucceeded(results) ||
    changes(results[0]) !== 1 ||
    changes(results[2]) !== 1
  ) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  return { ok: true, ownerId: challenge.ownerId, keyVersion };
}

export interface CompleteRecoveryInput {
  challengeId: string;
  oldKey: string;
  newKeyHash: string;
  now: number;
  nextProactiveAt: number;
}

async function loadRecoveryContext(
  db: D1Database,
  challengeId: string,
  now: number,
): Promise<RecoveryContextRow | null> {
  return db
    .prepare(
      `SELECT recovery_challenges.id, recovery_challenges.purpose,
              recovery_challenges.owner_id,
              recovery_challenges.requested_user_id,
              recovery_challenges.requested_chat_id,
              recovery_challenges.attempts,
              recovery_challenges.expires_at,
              owner_recovery.key_hash, owner_recovery.key_version,
              owners.telegram_user_id AS old_user_id,
              owners.telegram_chat_id AS old_chat_id
       FROM recovery_challenges
       JOIN owner_recovery ON owner_recovery.owner_id = recovery_challenges.owner_id
       JOIN owners ON owners.id = recovery_challenges.owner_id
       WHERE recovery_challenges.id = ?
         AND recovery_challenges.purpose = 'recover'
         AND recovery_challenges.consumed_at IS NULL
         AND recovery_challenges.expires_at >= ?
         AND recovery_challenges.attempts < ?`,
    )
    .bind(challengeId, now, MAX_CHALLENGE_ATTEMPTS)
    .first<RecoveryContextRow>();
}

async function recordFailedAttempt(
  db: D1Database,
  context: RecoveryContextRow,
  now: number,
): Promise<"recorded" | "rate_limited"> {
  const hash = await requesterHash(
    context.requested_user_id,
    context.requested_chat_id,
  );
  const usageDate = utcDate(now);
  const currentRate = await db
    .prepare(
      `SELECT challenge_count, failure_count
       FROM recovery_rate_limits
       WHERE requester_hash = ? AND usage_date = ?`,
    )
    .bind(hash, usageDate)
    .first<CountRow>();

  if ((currentRate?.failure_count ?? 0) >= MAX_DAILY_FAILURES) {
    return "rate_limited";
  }

  const results = await db.batch([
    db
      .prepare(
        `UPDATE recovery_challenges
         SET attempts = attempts + 1
         WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?
           AND attempts < ?`,
      )
      .bind(context.id, now, MAX_CHALLENGE_ATTEMPTS),
    db
      .prepare(
        `INSERT INTO recovery_rate_limits (
           requester_hash, usage_date, challenge_count, failure_count
         ) VALUES (?, ?, 0, 1)
         ON CONFLICT(requester_hash, usage_date) DO UPDATE SET
           failure_count = failure_count + 1
         WHERE failure_count < ?`,
      )
      .bind(hash, usageDate, MAX_DAILY_FAILURES),
  ]);

  return batchSucceeded(results) &&
    changes(results[0]) === 1 &&
    changes(results[1]) === 1
    ? "recorded"
    : "rate_limited";
}

export async function completeRecovery(
  db: D1Database,
  input: CompleteRecoveryInput,
): Promise<RecoveryMutationResult> {
  if (
    !isSha256Hex(input.newKeyHash) ||
    !Number.isSafeInteger(input.nextProactiveAt) ||
    input.nextProactiveAt <= input.now
  ) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const context = await loadRecoveryContext(db, input.challengeId, input.now);
  if (context === null) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const hash = await requesterHash(
    context.requested_user_id,
    context.requested_chat_id,
  );
  const dailyRate = await db
    .prepare(
      `SELECT challenge_count, failure_count
       FROM recovery_rate_limits
       WHERE requester_hash = ? AND usage_date = ?`,
    )
    .bind(hash, utcDate(input.now))
    .first<CountRow>();
  if ((dailyRate?.failure_count ?? 0) >= MAX_DAILY_FAILURES) {
    return { ok: false, reason: "rate_limited" };
  }

  const providedHash = await hashRecoveryKey(input.oldKey);
  if (
    providedHash === null ||
    !secureEqualHex(providedHash, context.key_hash)
  ) {
    const outcome = await recordFailedAttempt(db, context, input.now);
    return {
      ok: false,
      reason: outcome === "rate_limited" ? "rate_limited" : "invalid_or_expired",
    };
  }

  const keyVersion = context.key_version + 1;
  const [fromIdentityHash, toIdentityHash] = await Promise.all([
    requesterHash(context.old_user_id, context.old_chat_id),
    requesterHash(context.requested_user_id, context.requested_chat_id),
  ]);
  const activeRecovery = `EXISTS (
    SELECT 1 FROM recovery_challenges
    WHERE id = ? AND purpose = 'recover' AND owner_id = ?
      AND consumed_at IS NULL AND expires_at >= ? AND attempts < ?
  )`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE owners
         SET telegram_user_id = ?, telegram_chat_id = ?, migrated_at = ?
         WHERE id = ? AND telegram_user_id = ? AND telegram_chat_id = ?
           AND ${activeRecovery}`,
      )
      .bind(
        context.requested_user_id,
        context.requested_chat_id,
        input.now,
        context.owner_id,
        context.old_user_id,
        context.old_chat_id,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `UPDATE owner_recovery
         SET key_hash = ?, key_version = ?, created_at = ?
         WHERE owner_id = ? AND key_hash = ? AND key_version = ?
           AND ${activeRecovery}`,
      )
      .bind(
        input.newKeyHash,
        keyVersion,
        input.now,
        context.owner_id,
        context.key_hash,
        context.key_version,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `UPDATE deliveries
         SET status = 'cancelled', updated_at = ?
         WHERE owner_id = ? AND target_chat_id = ?
           AND status IN ('pending', 'sending') AND ${activeRecovery}`,
      )
      .bind(
        input.now,
        context.owner_id,
        context.old_chat_id,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `DELETE FROM pending_confirmations
         WHERE owner_id = ? AND ${activeRecovery}`,
      )
      .bind(
        context.owner_id,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `DELETE FROM persona_change_drafts
         WHERE owner_id = ? AND ${activeRecovery}`,
      )
      .bind(
        context.owner_id,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `INSERT INTO persona_runtime_state (
           owner_id, busy_until, next_proactive_at, updated_at
         ) SELECT ?, NULL, ?, ? WHERE ${activeRecovery}
         ON CONFLICT(owner_id) DO UPDATE SET
           busy_until = NULL,
           next_proactive_at = excluded.next_proactive_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        context.owner_id,
        input.nextProactiveAt,
        input.now,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `UPDATE recovery_challenges
         SET consumed_at = ?
         WHERE owner_id = ? AND id <> ? AND consumed_at IS NULL
           AND ${activeRecovery}`,
      )
      .bind(
        input.now,
        context.owner_id,
        input.challengeId,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `UPDATE recovery_challenges
         SET consumed_at = ?
         WHERE id = ? AND purpose = 'recover' AND owner_id = ?
           AND consumed_at IS NULL AND expires_at >= ? AND attempts < ?`,
      )
      .bind(
        input.now,
        input.challengeId,
        context.owner_id,
        input.now,
        MAX_CHALLENGE_ATTEMPTS,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO owner_recovery_events (
           challenge_id, owner_id, from_identity_hash, to_identity_hash,
           key_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.challengeId,
        context.owner_id,
        fromIdentityHash,
        toIdentityHash,
        keyVersion,
        input.now,
      ),
  ]);

  if (
    !batchSucceeded(results) ||
    changes(results[0]) !== 1 ||
    changes(results[1]) !== 1 ||
    changes(results[5]) !== 1 ||
    changes(results[7]) !== 1 ||
    changes(results[8]) !== 1
  ) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  return { ok: true, ownerId: context.owner_id, keyVersion };
}
