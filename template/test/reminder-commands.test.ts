import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleOwnerCommand } from "../src/commands";
import type { OwnerRecord } from "../src/domain";
import type { ReminderWorkflowBinding } from "../src/reminders";

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0) / 1_000;

async function owner(): Promise<OwnerRecord> {
  const row = await env.DB.prepare(
    "INSERT INTO owners (telegram_user_id, telegram_chat_id, paired_at) VALUES (91, 92, ?) RETURNING id",
  ).bind(NOW).first<{ id: number }>();
  return {
    ownerId: row!.id,
    telegramUserId: 91,
    telegramChatId: 92,
    pairedAt: NOW,
    migratedAt: null,
  };
}

function workflow(): ReminderWorkflowBinding & { terminated: string[] } {
  const terminated: string[] = [];
  return {
    terminated,
    async create(options) {
      return { id: options.id, async terminate() {} };
    },
    async get(id) {
      return { id, async terminate() { terminated.push(id); } };
    },
  };
}

describe("reminder commands", () => {
  it("creates, lists, and cancels a Beijing-time reminder", async () => {
    const currentOwner = await owner();
    const binding = workflow();
    const base = {
      db: env.DB,
      owner: currentOwner,
      now: NOW,
      recoveryBaseUrl: "https://persona.example",
      reminderWorkflow: binding,
    };
    const created = await handleOwnerCommand({ ...base, text: "/remind 明晚八点提醒我复习" });
    expect(created.messages[0]).toContain("2026-07-30 20:00");
    const code = created.messages[0]!.match(/[a-z0-9]{8}$/u)?.[0];
    expect(code).toBeDefined();
    const listed = await handleOwnerCommand({ ...base, text: "/reminders" });
    expect(listed.messages[0]).toContain("复习");
    const cancelled = await handleOwnerCommand({ ...base, text: `/remind-cancel ${code}` });
    expect(cancelled.messages).toEqual(["提醒已取消。"]);
    expect(binding.terminated).toHaveLength(1);
  });
});
