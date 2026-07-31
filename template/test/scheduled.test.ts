import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  calculateNextProactiveAt,
  handleScheduled,
  selectWeeklyTarget,
  type ScheduledDependencies,
} from "../src/scheduled";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import { seedPersona } from "../src/storage/persona-repository";
import { claimUpdate, markUpdate } from "../src/storage/update-repository";
import type { QueueJob, RandomSource } from "../src/queue";
import { processQueueMessage, type QueueDependencies } from "../src/queue";
import { vi } from "vitest";

const MONDAY = Math.floor(Date.parse("2026-07-20T00:00:00Z") / 1_000);

function source(values: number[]): RandomSource {
  let index = 0;
  return { nextUint32: () => values[index++] ?? values.at(-1) ?? 0 };
}

async function clearAll(): Promise<void> {
  await env.DB.exec(`
    DELETE FROM owner_recovery_events;
    DELETE FROM bot_configuration;
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
    DELETE FROM usage_daily;
    DELETE FROM processed_updates;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
}

async function fixture(): Promise<number> {
  const owner = await pairOwner(env.DB, 101, 201, MONDAY - 100);
  expect(owner).not.toBeNull();
  if (owner === null) throw new Error("owner_fixture_failed");
  await seedPersona(env.DB, owner.ownerId, MONDAY - 90);
  return owner.ownerId;
}

function dependencies(
  now: () => number,
  random: RandomSource = source([0]),
): { value: ScheduledDependencies; jobs: QueueJob[] } {
  const jobs: QueueJob[] = [];
  return {
    value: {
      now,
      random,
      queue: { send: async (job) => void jobs.push(job) },
      fetcher: async () => Response.json({ ok: true, result: true }),
    },
    jobs,
  };
}

beforeEach(clearAll);

it("configures Telegram management exactly once after a successful API call", async () => {
  const methods: string[] = [];
  const deps = dependencies(() => MONDAY);
  deps.value.fetcher = async (input) => {
    methods.push(new URL(String(input)).pathname.split("/").at(-1) ?? "");
    return Response.json({ ok: true, result: true });
  };
  await handleScheduled(env, deps.value);
  await handleScheduled(env, deps.value);
  expect(methods).toEqual(["setWebhook", "setChatMenuButton"]);
  expect(await env.DB.prepare(
    "SELECT value FROM bot_configuration WHERE key = 'telegram_management_v1'",
  ).first()).toEqual({ value: "configured" });
});

it("queues bounded pending vector synchronization work", async () => {
  const ownerId = await fixture();
  await env.DB.prepare(
    `INSERT INTO memory_vector_jobs (
       owner_id, entity_kind, entity_id, operation, status, created_at, updated_at
     ) VALUES (?, 'fact', 999, 'delete', 'pending', ?, ?)`,
  ).bind(ownerId, MONDAY, MONDAY).run();
  const deps = dependencies(() => MONDAY);
  await handleScheduled(env, deps.value);
  expect(deps.jobs).toContainEqual({ type: "memory_vector_sync", ownerId });
});

it("requeues an overdue persona memory summary from the scheduled recovery pass", async () => {
  const ownerId = await fixture();
  const conversation = await getOrCreateActiveConversation(env.DB, ownerId, MONDAY);
  for (let index = 0; index < 16; index += 1) {
    await appendMessage(env.DB, {
      ownerId,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: `message-${index}`,
      telegramUpdateId: 10_000 + index,
      createdAt: MONDAY + index,
    });
  }
  const deps = dependencies(() => MONDAY + 100);
  await handleScheduled(env, deps.value);
  expect(deps.jobs).toContainEqual({
    type: "memory_update",
    ownerId,
    conversationId: conversation.conversationId,
  });
});

describe("weekly proactive schedule", () => {
  it("chooses exactly one or two contacts and has no quiet-hour restriction", () => {
    expect(selectWeeklyTarget(source([0]))).toBe(1);
    expect(selectWeeklyTarget(source([0xffff_ffff]))).toBe(2);

    const weekEnd = MONDAY + 7 * 86_400;
    const atMidnight = calculateNextProactiveAt(
      MONDAY,
      weekEnd,
      null,
      source([0]),
    );
    const lateNight = calculateNextProactiveAt(
      MONDAY,
      weekEnd,
      null,
      source([0xffff_ffff]),
    );
    expect(atMidnight).toBe(MONDAY);
    expect(lateNight).toBeLessThan(weekEnd);
    expect(new Date(lateNight * 1_000).getUTCHours()).toBeGreaterThanOrEqual(0);
  });

  it("enqueues at most the target with a 48-hour gap and no follow-up after silence", async () => {
    const ownerId = await fixture();
    await env.DB
      .prepare(
        `INSERT INTO persona_runtime_state (
           owner_id, next_proactive_at, week_start, weekly_target,
           weekly_sent, updated_at
         ) VALUES (?, ?, '2026-07-20', 2, 0, ?)`,
      )
      .bind(ownerId, MONDAY, MONDAY)
      .run();
    let now = MONDAY;
    const deps = dependencies(() => now, source([0]));

    await handleScheduled(env, deps.value);
    expect(deps.jobs).toEqual([
      { type: "proactive", ownerId, scheduledAt: MONDAY },
    ]);
    const state = await env.DB
      .prepare(
        `SELECT weekly_sent, last_proactive_at, next_proactive_at
         FROM persona_runtime_state WHERE owner_id = ?`,
      )
      .bind(ownerId)
      .first<{
        weekly_sent: number;
        last_proactive_at: number;
        next_proactive_at: number | null;
      }>();
    expect(state?.weekly_sent).toBe(1);
    expect(state?.last_proactive_at).toBe(MONDAY);
    expect(state?.next_proactive_at).toBeGreaterThanOrEqual(MONDAY + 48 * 3_600);

    now = state?.next_proactive_at ?? MONDAY + 48 * 3_600;
    await handleScheduled(env, deps.value);
    expect(deps.jobs).toHaveLength(1);
    expect(
      await env.DB
        .prepare("SELECT next_proactive_at FROM persona_runtime_state WHERE owner_id = ?")
        .bind(ownerId)
        .first(),
    ).toEqual({ next_proactive_at: null });
  });

  it("permits a second contact after OWNER replied and suppresses pending messages", async () => {
    const ownerId = await fixture();
    const due = MONDAY + 48 * 3_600;
    await env.DB
      .prepare(
        `INSERT INTO persona_runtime_state (
           owner_id, next_proactive_at, week_start, weekly_target,
           weekly_sent, last_proactive_at, updated_at
         ) VALUES (?, ?, '2026-07-20', 2, 1, ?, ?)`,
      )
      .bind(ownerId, due, MONDAY, MONDAY)
      .run();
    const conversation = await getOrCreateActiveConversation(env.DB, ownerId, MONDAY + 10);
    await claimUpdate(env.DB, 9001, ownerId, MONDAY + 20);
    await appendMessage(env.DB, {
      ownerId,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "我回来啦",
      telegramUpdateId: 9001,
      createdAt: MONDAY + 20,
    });
    await markUpdate(env.DB, 9001, "completed", MONDAY + 21);

    let now = due;
    const deps = dependencies(() => now);
    await handleScheduled(env, deps.value);
    expect(deps.jobs).toEqual([{ type: "proactive", ownerId, scheduledAt: due }]);

    await env.DB
      .prepare(
        `UPDATE persona_runtime_state
         SET weekly_sent = 0, last_proactive_at = NULL, next_proactive_at = ?
         WHERE owner_id = ?`,
      )
      .bind(due + 100, ownerId)
      .run();
    await claimUpdate(env.DB, 9002, ownerId, due + 50);
    await appendMessage(env.DB, {
      ownerId,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "还没处理的消息",
      telegramUpdateId: 9002,
      createdAt: due + 50,
    });
    await markUpdate(env.DB, 9002, "queued", due + 50);
    now = due + 100;
    await handleScheduled(env, deps.value);
    expect(deps.jobs).toHaveLength(1);
  });

  it("resets a new UTC week deterministically", async () => {
    const ownerId = await fixture();
    await env.DB
      .prepare(
        `INSERT INTO persona_runtime_state (
           owner_id, next_proactive_at, week_start, weekly_target,
           weekly_sent, last_proactive_at, updated_at
         ) VALUES (?, NULL, '2026-07-13', 2, 2, ?, ?)`,
      )
      .bind(ownerId, MONDAY - 86_400, MONDAY - 86_400)
      .run();
    const deps = dependencies(() => MONDAY, source([0, 0]));
    await handleScheduled(env, deps.value);

    expect(
      await env.DB
        .prepare(
          `SELECT week_start, weekly_target, weekly_sent
           FROM persona_runtime_state WHERE owner_id = ?`,
        )
        .bind(ownerId)
        .first(),
    ).toEqual({ week_start: "2026-07-20", weekly_target: 1, weekly_sent: 1 });
  });
});

describe("scheduled cleanup", () => {
  it("removes expired drafts, confirmations, and unused recovery challenges", async () => {
    const ownerId = await fixture();
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO persona_change_drafts (
             id, owner_id, operation, summary, impact_scope, patch_json,
             expires_at, created_at
           ) VALUES ('old', ?, 'addition', 'old', 'x', '[]', ?, ?),
                    ('new', ?, 'addition', 'new', 'x', '[]', ?, ?)`,
        )
        .bind(ownerId, MONDAY - 1, MONDAY - 100, ownerId, MONDAY + 100, MONDAY),
      env.DB
        .prepare(
          `INSERT INTO pending_confirmations (owner_id, command, payload_json, expires_at)
           VALUES (?, 'x', '{}', ?)`,
        )
        .bind(ownerId, MONDAY - 1),
      env.DB
        .prepare(
          `INSERT INTO recovery_challenges (
             id, purpose, owner_id, requested_user_id, requested_chat_id,
             expires_at, created_at
           ) VALUES ('old-recovery', 'setup', ?, 101, 201, ?, ?)`,
        )
        .bind(ownerId, MONDAY - 1, MONDAY - 100),
    ]);
    const deps = dependencies(() => MONDAY);
    await handleScheduled(env, deps.value);

    expect(
      await env.DB.prepare("SELECT id FROM persona_change_drafts ORDER BY id").all(),
    ).toMatchObject({ results: [{ id: "new" }] });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM pending_confirmations").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM recovery_challenges").first(),
    ).toEqual({ count: 0 });
  });
});

describe("proactive queue content", () => {
  it("generates only an approved contact type and persists it before delivery", async () => {
    const ownerId = await fixture();
    const bodies: string[] = [];
    const queued: QueueJob[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "干啥呢最近" } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const dependencies: QueueDependencies = {
      fetcher,
      queue: { send: async (job) => void queued.push(job) },
      now: () => MONDAY,
      random: source([0xffff_ffff]),
      busyProbabilityPercent: 0,
      dailyMessageLimit: 200,
    };

    await processQueueMessage(
      { type: "proactive", ownerId, scheduledAt: MONDAY },
      env,
      dependencies,
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("[PROACTIVE_CONTACT]");
    expect(bodies[0]).toContain("学习和生活");
    expect(bodies[0]).toContain("延续旧话题");
    expect(bodies[0]).toContain("轻松问题或观点");
    expect(bodies[0]).toContain("休息或吃饭");
    expect(bodies[0]).toContain("不得虚构");
    expect(
      await env.DB.prepare("SELECT content FROM messages WHERE role = 'assistant'").first(),
    ).toEqual({ content: "干啥呢最近" });
    expect(queued.some((job) => job.type === "bubble")).toBe(true);
  });
});
