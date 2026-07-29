import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { OwnerRecord } from "../src/domain";
import {
  CONFIRM_FORGET_ALL,
  CONFIRM_FORGET_CURRENT,
  CONFIRM_PERSONA_DELETE,
  handleOwnerCommand,
  parseCommand,
} from "../src/commands";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { upsertMemoryFacts } from "../src/storage/memory-repository";
import { pairOwner } from "../src/storage/owner-repository";
import { seedPersona } from "../src/storage/persona-repository";
import { queueMemoryVectorJob } from "../src/storage/semantic-memory-repository";
import {
  addDailyTokenUsage,
  reserveDailyRequest,
} from "../src/storage/usage-repository";

const NOW = 1_750_000_000;

async function clearAll(): Promise<void> {
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
    DELETE FROM usage_daily;
    DELETE FROM processed_updates;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
}

async function fixture(): Promise<{
  owner: OwnerRecord;
  conversationId: number;
  messageId: number;
}> {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  expect(owner).not.toBeNull();
  if (owner === null) throw new Error("owner_fixture_failed");
  await seedPersona(env.DB, owner.ownerId, NOW + 1);
  const conversation = await getOrCreateActiveConversation(
    env.DB,
    owner.ownerId,
    NOW + 2,
  );
  const message = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "persona",
    content: "我最近在准备考试",
    createdAt: NOW + 3,
  });
  await upsertMemoryFacts(
    env.DB,
    owner.ownerId,
    conversation.conversationId,
    [
      {
        category: "study",
        factKey: "current_exam",
        factValue: "OWNER 最近在准备考试",
        confidence: "high",
        sourceMessageId: message.messageId,
      },
    ],
    NOW + 4,
  );
  return {
    owner,
    conversationId: conversation.conversationId,
    messageId: message.messageId,
  };
}

function command(owner: OwnerRecord, text: string) {
  return handleOwnerCommand({
    db: env.DB,
    owner,
    text,
    now: NOW + 10,
    recoveryBaseUrl: "https://persona.example",
  });
}

beforeEach(clearAll);

describe("command parsing", () => {
  it("is case-insensitive and strips an optional bot username", () => {
    expect(parseCommand("/UsAgE@PersonalBot extra")).toEqual({
      name: "usage",
      argument: "extra",
    });
    expect(parseCommand("not a command")).toBeNull();
  });
});

describe("owner utility commands", () => {
  it("returns one categorized help message without queue work", async () => {
    const { owner } = await fixture();
    const result = await command(owner, "/help@PersonalBot");
    expect(result.handled).toBe(true);
    expect(result.enqueue).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    const help = result.messages[0] ?? "";
    for (const heading of ["日常聊天", "记忆管理", "人格管理", "账号与面板"]) {
      expect(help).toContain(heading);
    }
    for (const name of [
      "/new",
      "/ask",
      "/usage",
      "/memory",
      "/forget",
      "/persona-add",
      "/persona-history",
      "/persona-rollback",
      "/persona-export",
      "/persona-delete",
      "/settings",
      "/recovery-key",
      "/recover",
    ]) {
      expect(help).toContain(name);
    }
    expect(help).not.toContain("/pair");
    expect(help.length).toBeLessThanOrEqual(4_000);
  });

  it("supports new topic, memory, usage, ask, and recovery-key setup", async () => {
    const { owner, conversationId } = await fixture();
    await reserveDailyRequest(env.DB, owner.ownerId, "2025-06-15", 200);
    await addDailyTokenUsage(env.DB, owner.ownerId, "2025-06-15", 120, 30);

    const memory = await command(owner, "/memory");
    expect(memory.handled).toBe(true);
    expect(memory.messages.join("\n")).toContain("准备考试");

    const usage = await command(owner, "/usage");
    expect(usage.messages.join("\n")).toContain("120");
    expect(usage.messages.join("\n")).toContain("30");

    const ask = await command(owner, "/ask 解释麦克斯韦方程组");
    expect(ask).toMatchObject({
      handled: true,
      enqueue: { mode: "ask", content: "解释麦克斯韦方程组" },
    });

    const recovery = await command(owner, "/recovery-key");
    expect(recovery.messages.join("\n")).toContain(
      "https://persona.example/recover?challenge=",
    );

    const next = await command(owner, "/new");
    expect(next.messages.join("\n")).toContain("新话题");
    expect(
      await env.DB
        .prepare("SELECT status FROM conversations WHERE id = ?")
        .bind(conversationId)
        .first(),
    ).toEqual({ status: "closed" });
  });

  it("lists, exports, and rolls back persona versions", async () => {
    const { owner } = await fixture();

    const history = await command(owner, "/persona-history");
    expect(history.messages.join("\n")).toContain("v1");
    const exported = await command(owner, "/persona-export");
    expect(exported.messages.join("\n")).toContain('"displayName":"Persona Bot"');
    const rollback = await command(owner, "/persona-rollback 1");
    expect(rollback.messages.join("\n")).toContain("v2");
  });
});

describe("privacy deletion confirmations", () => {
  it("forgets only the current topic and its exclusively sourced facts", async () => {
    const { owner, conversationId } = await fixture();
    const fact = await env.DB.prepare("SELECT id FROM memory_facts").first<{ id: number }>();
    if (fact === null) throw new Error("fact_missing");
    await queueMemoryVectorJob(env.DB, owner.ownerId, "fact", fact.id, "upsert", NOW + 5);
    const requested = await command(owner, "/forget");
    expect(requested.messages).toEqual([
      `这只会删除当前话题的完整消息、摘要和仅来源于它的长期事实。请发送“${CONFIRM_FORGET_CURRENT}”确认。`,
    ]);

    expect((await command(owner, "确认忘记当前话题 ")).messages).toEqual([]);
    const confirmed = await command(owner, CONFIRM_FORGET_CURRENT);
    expect(confirmed.messages).toEqual(["当前话题已删除。"]);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = ?")
        .bind(conversationId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_facts").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM owners").first(),
    ).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT operation FROM memory_vector_jobs WHERE entity_kind = 'fact' AND entity_id = ?",
    ).bind(fact.id).first()).toEqual({ operation: "delete" });
  });

  it("forgets all chat-derived data but preserves owner, recovery, and persona", async () => {
    const { owner } = await fixture();
    const fact = await env.DB.prepare("SELECT id FROM memory_facts").first<{ id: number }>();
    if (fact === null) throw new Error("fact_missing");
    await queueMemoryVectorJob(env.DB, owner.ownerId, "fact", fact.id, "upsert", NOW + 5);
    await env.DB
      .prepare(
        `INSERT INTO owner_recovery (owner_id, key_hash, key_version, created_at)
         VALUES (?, ?, 1, ?)`,
      )
      .bind(owner.ownerId, "0".repeat(64), NOW)
      .run();
    await reserveDailyRequest(env.DB, owner.ownerId, "2025-06-15", 200);

    const requested = await command(owner, "/forget all");
    expect(requested.messages[0]).toContain(CONFIRM_FORGET_ALL);
    const confirmed = await command(owner, CONFIRM_FORGET_ALL);
    expect(confirmed.messages).toEqual(["全部聊天和长期聊天记忆已删除。"]);

    for (const table of [
      "conversations",
      "messages",
      "conversation_summaries",
      "memory_facts",
      "deliveries",
      "processed_updates",
      "usage_daily",
    ]) {
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(),
      ).toEqual({ count: 0 });
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM owners").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM owner_recovery").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_profiles").first(),
    ).toEqual({ count: 1 });
    expect(await env.DB.prepare(
      "SELECT operation FROM memory_vector_jobs WHERE entity_kind = 'fact' AND entity_id = ?",
    ).bind(fact.id).first()).toEqual({ operation: "delete" });
  });

  it("deletes only Persona Bot persona after an exact distinct confirmation", async () => {
    const { owner } = await fixture();
    const requested = await command(owner, "/persona-delete");
    expect(requested.messages[0]).toContain(CONFIRM_PERSONA_DELETE);
    expect(requested.messages[0]).toContain("不会删除聊天");

    const confirmed = await command(owner, CONFIRM_PERSONA_DELETE);
    expect(confirmed.messages).toEqual(["Persona Bot 人格及其版本已删除，聊天数据仍保留。"]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_profiles").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_facts").first(),
    ).toEqual({ count: 1 });
  });
});
