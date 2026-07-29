import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashRecoveryKey } from "../src/recovery-key";
import { handleRecoveryHttp } from "../src/recovery";
import {
  completeRecovery,
  createRecoveryChallenge,
  createSetupChallenge,
  setupRecoveryKey,
} from "../src/storage/recovery-repository";
import { getOwner, pairOwner } from "../src/storage/owner-repository";

const NOW = 1_750_000_000;
const OLD_KEY = "YR-0123-4567-89AB-CDEF";
const NEW_KEY = "YR-FEDC-BA98-7654-3210";
const NEXT_KEY = "YR-1111-2222-3333-4444";

async function clearRecoveryFixture(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM owner_recovery_events;
    DELETE FROM recovery_rate_limits;
    DELETE FROM recovery_challenges;
    DELETE FROM owner_recovery;
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM pending_confirmations;
    DELETE FROM deliveries;
    DELETE FROM processed_updates;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
}

async function configureOldKey(): Promise<number> {
  const owner = await pairOwner(env.DB, 101, 201, NOW - 100);
  expect(owner).not.toBeNull();
  if (owner === null) throw new Error("owner_fixture_failed");

  const challenge = await createSetupChallenge(env.DB, 101, 201, NOW);
  expect(challenge.ok).toBe(true);
  if (!challenge.ok) throw new Error("setup_challenge_failed");

  const oldHash = await hashRecoveryKey(OLD_KEY);
  expect(oldHash).not.toBeNull();
  if (oldHash === null) throw new Error("old_key_hash_failed");

  expect(
    await setupRecoveryKey(env.DB, {
      challengeId: challenge.challengeId,
      newKeyHash: oldHash,
      now: NOW + 1,
    }),
  ).toEqual({ ok: true, ownerId: owner.ownerId, keyVersion: 1 });

  return owner.ownerId;
}

beforeEach(clearRecoveryFixture);

describe("recovery challenge policy", () => {
  it("allows only the current owner to set a key and expires in ten minutes", async () => {
    await pairOwner(env.DB, 101, 201, NOW - 100);

    expect(await createSetupChallenge(env.DB, 999, 201, NOW)).toEqual({
      ok: false,
      reason: "not_owner",
    });

    const challenge = await createSetupChallenge(env.DB, 101, 201, NOW);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    expect(challenge.expiresAt).toBe(NOW + 600);

    const keyHash = await hashRecoveryKey(OLD_KEY);
    expect(keyHash).not.toBeNull();
    if (keyHash === null) return;

    expect(
      await setupRecoveryKey(env.DB, {
        challengeId: challenge.challengeId,
        newKeyHash: keyHash,
        now: NOW + 601,
      }),
    ).toEqual({ ok: false, reason: "invalid_or_expired" });

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_recovery")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("consumes setup challenges once", async () => {
    const owner = await pairOwner(env.DB, 101, 201, NOW - 100);
    expect(owner).not.toBeNull();
    const challenge = await createSetupChallenge(env.DB, 101, 201, NOW);
    expect(challenge.ok).toBe(true);
    if (owner === null || !challenge.ok) return;

    const keyHash = await hashRecoveryKey(OLD_KEY);
    expect(keyHash).not.toBeNull();
    if (keyHash === null) return;

    const input = {
      challengeId: challenge.challengeId,
      newKeyHash: keyHash,
      now: NOW + 1,
    };
    expect(await setupRecoveryKey(env.DB, input)).toEqual({
      ok: true,
      ownerId: owner.ownerId,
      keyVersion: 1,
    });
    expect(await setupRecoveryKey(env.DB, input)).toEqual({
      ok: false,
      reason: "invalid_or_expired",
    });
  });

  it("limits each requester to five recovery challenges per UTC day", async () => {
    await configureOldKey();

    for (let index = 0; index < 5; index += 1) {
      expect(
        (await createRecoveryChallenge(env.DB, 501, 601, NOW + index)).ok,
      ).toBe(true);
    }

    expect(await createRecoveryChallenge(env.DB, 501, 601, NOW + 5)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(
      (await createRecoveryChallenge(env.DB, 502, 602, NOW + 5)).ok,
    ).toBe(true);
  });

  it("locks a challenge after five wrong keys without changing the binding", async () => {
    await configureOldKey();
    const challenge = await createRecoveryChallenge(env.DB, 501, 601, NOW + 2);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;

    const newHash = await hashRecoveryKey(NEW_KEY);
    expect(newHash).not.toBeNull();
    if (newHash === null) return;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await completeRecovery(env.DB, {
          challengeId: challenge.challengeId,
          oldKey: "YR-0000-0000-0000-0000",
          newKeyHash: newHash,
          now: NOW + 3 + attempt,
          nextProactiveAt: NOW + 90_000,
        }),
      ).toEqual({ ok: false, reason: "invalid_or_expired" });
    }

    expect(
      await completeRecovery(env.DB, {
        challengeId: challenge.challengeId,
        oldKey: OLD_KEY,
        newKeyHash: newHash,
        now: NOW + 9,
        nextProactiveAt: NOW + 90_000,
      }),
    ).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(await getOwner(env.DB)).toMatchObject({
      telegramUserId: 101,
      telegramChatId: 201,
    });
  });

  it("locks a requester after ten failed validations in one UTC day", async () => {
    await configureOldKey();
    const newHash = await hashRecoveryKey(NEW_KEY);
    expect(newHash).not.toBeNull();
    if (newHash === null) return;

    for (let challengeIndex = 0; challengeIndex < 2; challengeIndex += 1) {
      const challenge = await createRecoveryChallenge(
        env.DB,
        501,
        601,
        NOW + 2 + challengeIndex * 10,
      );
      expect(challenge.ok).toBe(true);
      if (!challenge.ok) return;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await completeRecovery(env.DB, {
          challengeId: challenge.challengeId,
          oldKey: "YR-0000-0000-0000-0000",
          newKeyHash: newHash,
          now: NOW + 3 + challengeIndex * 10 + attempt,
          nextProactiveAt: NOW + 90_000,
        });
      }
    }

    expect(await createRecoveryChallenge(env.DB, 501, 601, NOW + 30)).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });
});

describe("atomic owner migration", () => {
  it("keeps durable data on the stable owner while revoking old delivery state", async () => {
    const ownerId = await configureOldKey();
    const conversation = await env.DB.prepare(
      `INSERT INTO conversations (owner_id, status, message_count, created_at, updated_at)
       VALUES (?, 'active', 1, ?, ?) RETURNING id`,
    )
      .bind(ownerId, NOW, NOW)
      .first<{ id: number }>();
    expect(conversation).not.toBeNull();
    if (conversation === null) return;

    const message = await env.DB.prepare(
      `INSERT INTO messages (owner_id, conversation_id, role, mode, content, created_at)
       VALUES (?, ?, 'user', 'persona', 'private fixture', ?) RETURNING id`,
    )
      .bind(ownerId, conversation.id, NOW)
      .first<{ id: number }>();
    expect(message).not.toBeNull();
    if (message === null) return;

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO memory_facts (
             owner_id, source_conversation_id, source_message_id, category,
             fact_key, fact_value, confidence, created_at, updated_at
           ) VALUES (?, ?, ?, 'preference', 'fruit', 'likes fruit', 'high', ?, ?)`,
        )
        .bind(ownerId, conversation.id, message.id, NOW, NOW),
      env.DB
        .prepare(
          `INSERT INTO deliveries (
             owner_id, kind, chunk_index, chunk_text, target_at, target_chat_id,
             status, created_at, updated_at
           ) VALUES (?, 'notice', 0, 'pending fixture', ?, 201, 'pending', ?, ?)`,
        )
        .bind(ownerId, NOW + 100, NOW, NOW),
      env.DB
        .prepare(
          `INSERT INTO pending_confirmations (owner_id, command, payload_json, expires_at)
           VALUES (?, '/forget', '{}', ?)`,
        )
        .bind(ownerId, NOW + 100),
      env.DB
        .prepare(
          `INSERT INTO persona_change_drafts (
             id, owner_id, operation, summary, impact_scope, patch_json,
             expires_at, created_at
           ) VALUES ('draft-1', ?, 'addition', 'fixture', 'style', '{}', ?, ?)`,
        )
        .bind(ownerId, NOW + 100, NOW),
      env.DB
        .prepare(
          `INSERT INTO persona_runtime_state (
             owner_id, busy_until, next_proactive_at, updated_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .bind(ownerId, NOW + 7_200, NOW + 500, NOW),
    ]);

    const challenge = await createRecoveryChallenge(env.DB, 501, 601, NOW + 2);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    const newHash = await hashRecoveryKey(NEW_KEY);
    expect(newHash).not.toBeNull();
    if (newHash === null) return;

    expect(
      await completeRecovery(env.DB, {
        challengeId: challenge.challengeId,
        oldKey: OLD_KEY,
        newKeyHash: newHash,
        now: NOW + 3,
        nextProactiveAt: NOW + 172_800,
      }),
    ).toEqual({ ok: true, ownerId, keyVersion: 2 });

    expect(await getOwner(env.DB)).toMatchObject({
      ownerId,
      telegramUserId: 501,
      telegramChatId: 601,
      migratedAt: NOW + 3,
    });
    expect(
      await env.DB
        .prepare("SELECT owner_id, content FROM messages WHERE id = ?")
        .bind(message.id)
        .first(),
    ).toEqual({ owner_id: ownerId, content: "private fixture" });
    expect(
      await env.DB.prepare("SELECT owner_id, fact_value FROM memory_facts").first(),
    ).toEqual({ owner_id: ownerId, fact_value: "likes fruit" });
    expect(
      await env.DB.prepare("SELECT status FROM deliveries").first(),
    ).toEqual({ status: "cancelled" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM pending_confirmations").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_change_drafts").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB
        .prepare(
          "SELECT busy_until, next_proactive_at FROM persona_runtime_state WHERE owner_id = ?",
        )
        .bind(ownerId)
        .first(),
    ).toEqual({ busy_until: null, next_proactive_at: NOW + 172_800 });
    expect(
      await env.DB
        .prepare(
          "SELECT key_version, key_hash FROM owner_recovery WHERE owner_id = ?",
        )
        .bind(ownerId)
        .first(),
    ).toEqual({ key_version: 2, key_hash: newHash });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_recovery_events").first(),
    ).toEqual({ count: 1 });

    const second = await createRecoveryChallenge(env.DB, 701, 801, NOW + 4);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(
      await completeRecovery(env.DB, {
        challengeId: second.challengeId,
        oldKey: OLD_KEY,
        newKeyHash: newHash,
        now: NOW + 5,
        nextProactiveAt: NOW + 200_000,
      }),
    ).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(await getOwner(env.DB)).toMatchObject({ telegramUserId: 501 });

    const nextHash = await hashRecoveryKey(NEXT_KEY);
    expect(nextHash).not.toBeNull();
    if (nextHash === null) return;
    expect(
      await completeRecovery(env.DB, {
        challengeId: second.challengeId,
        oldKey: NEW_KEY,
        newKeyHash: nextHash,
        now: NOW + 6,
        nextProactiveAt: NOW + 200_000,
      }),
    ).toEqual({ ok: true, ownerId, keyVersion: 3 });
    expect(await getOwner(env.DB)).toMatchObject({ telegramUserId: 701 });
  });
});

describe("recovery HTTP surface", () => {
  it("renders only active challenges and uses generic no-store errors", async () => {
    await configureOldKey();
    const challenge = await createRecoveryChallenge(env.DB, 501, 601, NOW + 2);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;

    const page = await handleRecoveryHttp(
      new Request(
        `https://persona.example/recover?challenge=${challenge.challengeId}`,
      ),
      env.DB,
      NOW + 3,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("/api/recovery/complete");

    const badRequests = [
      new Request("https://persona.example/api/recovery/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          oldKey: "wrong",
          newKeyHash: "0".repeat(64),
        }),
      }),
      new Request("https://persona.example/api/recovery/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: crypto.randomUUID(),
          oldKey: OLD_KEY,
          newKeyHash: "0".repeat(64),
        }),
      }),
    ];
    const responses = await Promise.all(
      badRequests.map((request) =>
        handleRecoveryHttp(request, env.DB, NOW + 4),
      ),
    );
    expect(responses).toHaveLength(2);
    const wrongKey = responses[0]!;
    const missingChallenge = responses[1]!;
    expect(wrongKey.status).toBe(400);
    expect(missingChallenge.status).toBe(400);
    expect(await wrongKey.text()).toBe(await missingChallenge.text());
    expect(wrongKey.headers.get("referrer-policy")).toBe("no-referrer");
    expect(wrongKey.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects JSON request bodies larger than 4 KiB", async () => {
    const response = await handleRecoveryHttp(
      new Request("https://persona.example/api/recovery/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(4_097) }),
      }),
      env.DB,
      NOW,
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
