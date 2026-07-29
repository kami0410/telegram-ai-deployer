import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  cancelReminder,
  createReminder,
  getPendingReminder,
  listPendingReminders,
  markReminderSent,
  claimReminderDelivery,
} from "../src/storage/reminder-repository";
import { recoverStaleReminderDeliveries } from "../src/scheduled";

describe("reminder repository", () => {
  it("creates, lists, sends, and idempotently cancels reminders", async () => {
    const owner = await env.DB.prepare(
      "INSERT INTO owners (telegram_user_id, telegram_chat_id, paired_at) VALUES (1, 2, 10) RETURNING id",
    ).first<{ id: number }>();
    const reminder = await createReminder(env.DB, {
      ownerId: owner!.id,
      content: "复习",
      dueAt: 1_000,
      now: 100,
    });
    expect(reminder.code).toMatch(/^[a-z0-9]{8}$/u);
    expect(await listPendingReminders(env.DB, owner!.id, 10)).toHaveLength(1);
    expect(await getPendingReminder(env.DB, reminder.id, owner!.id)).toMatchObject({
      content: "复习",
      dueAt: 1_000,
    });
    expect(await markReminderSent(env.DB, reminder.id, owner!.id, 1_001)).toBe(true);
    expect(await markReminderSent(env.DB, reminder.id, owner!.id, 1_002)).toBe(false);
    expect(await cancelReminder(env.DB, owner!.id, reminder.code, 1_003)).toBe("already_done");
  });

  it("cancels a pending reminder once", async () => {
    const owner = await env.DB.prepare(
      "INSERT INTO owners (telegram_user_id, telegram_chat_id, paired_at) VALUES (3, 4, 10) RETURNING id",
    ).first<{ id: number }>();
    const reminder = await createReminder(env.DB, {
      ownerId: owner!.id,
      content: "喝水",
      dueAt: 2_000,
      now: 100,
    });
    expect(await cancelReminder(env.DB, owner!.id, reminder.code, 200)).toBe("cancelled");
    expect(await cancelReminder(env.DB, owner!.id, reminder.code, 201)).toBe("already_done");
  });

  it("does not report cancellation success after delivery was claimed", async () => {
    const owner = await env.DB.prepare(
      "INSERT INTO owners (telegram_user_id, telegram_chat_id, paired_at) VALUES (5, 6, 10) RETURNING id",
    ).first<{ id: number }>();
    const reminder = await createReminder(env.DB, {
      ownerId: owner!.id,
      content: "出门",
      dueAt: 3_000,
      now: 100,
    });
    expect(await claimReminderDelivery(env.DB, reminder.id, owner!.id, 3_000)).not.toBeNull();
    expect(await cancelReminder(env.DB, owner!.id, reminder.code, 3_000)).toBe("too_late");
    expect(await claimReminderDelivery(env.DB, reminder.id, owner!.id, 3_001)).toBeNull();
    const jobs: unknown[] = [];
    expect(await recoverStaleReminderDeliveries(env, {
      queue: { send: async (job) => { jobs.push(job); } },
    }, 3_601)).toBe(1);
    expect(jobs).toEqual([{
      type: "reminder_delivery",
      reminderId: reminder.id,
      ownerId: owner!.id,
    }]);
    expect(await claimReminderDelivery(env.DB, reminder.id, owner!.id, 3_602)).not.toBeNull();
  });

  it("continues recovering later stale reminders when one re-enqueue fails", async () => {
    const owner = await env.DB.prepare(
      "INSERT INTO owners (telegram_user_id, telegram_chat_id, paired_at) VALUES (7, 8, 10) RETURNING id",
    ).first<{ id: number }>();
    const reminders = [];
    for (const [index, content] of ["一", "二", "三"].entries()) {
      const reminder = await createReminder(env.DB, {
        ownerId: owner!.id,
        content,
        dueAt: 4_000 + index,
        now: 100 + index,
      });
      await claimReminderDelivery(env.DB, reminder.id, owner!.id, 4_000);
      reminders.push(reminder);
    }
    const jobs: Array<{ reminderId: string }> = [];
    const attemptedIds: string[] = [];
    let ownerAttempts = 0;
    await expect(recoverStaleReminderDeliveries(env, {
      queue: {
        send: async (job) => {
          if (job.type !== "reminder_delivery" || job.ownerId !== owner!.id) return;
          ownerAttempts += 1;
          attemptedIds.push(job.reminderId);
          if (ownerAttempts === 2) throw new Error("middle_enqueue_failed");
          jobs.push(job);
        },
      },
    }, 4_601)).rejects.toThrow("middle_enqueue_failed");
    expect(attemptedIds).toHaveLength(3);
    expect(jobs.map((job) => job.reminderId)).toEqual([
      attemptedIds[0],
      attemptedIds[2],
    ]);
    const failed = await env.DB.prepare(
      "SELECT claimed_at FROM reminders WHERE id = ?",
    ).bind(attemptedIds[1]).first<{ claimed_at: number | null }>();
    expect(failed?.claimed_at).not.toBeNull();
  });
});
