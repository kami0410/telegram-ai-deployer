import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRM_PERSONA_ADDITION,
  CONFIRM_PERSONA_CORRECTION,
  handleOwnerCommand,
} from "../src/commands";
import { processQueueMessage, type QueueDependencies } from "../src/queue";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import {
  getCurrentPersona,
  seedPersona,
} from "../src/storage/persona-repository";
import { claimUpdate, markUpdate } from "../src/storage/update-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM deliveries;
    DELETE FROM usage_daily;
    DELETE FROM processed_updates;
    DELETE FROM memory_facts;
    DELETE FROM conversation_summaries;
    DELETE FROM messages;
    DELETE FROM conversations;
    DELETE FROM owners;
  `);
});

async function fixture(text: string, mode: "persona" | "system" = "persona") {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  expect(owner).not.toBeNull();
  if (owner === null) throw new Error("owner_fixture_failed");
  await seedPersona(env.DB, owner.ownerId, NOW + 1);
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW + 2);
  await claimUpdate(env.DB, 9001, owner.ownerId, NOW + 3);
  const message = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode,
    content: text,
    telegramUpdateId: 9001,
    createdAt: NOW + 3,
  });
  await markUpdate(env.DB, 9001, "queued", NOW + 3);
  return { owner, message };
}

function deps(
  proposal: unknown,
  deepSeekBodies: Array<Record<string, unknown>> = [],
  telegramTexts: string[] = [],
  telegramBodies: Array<Record<string, unknown>> = [],
): QueueDependencies {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.deepseek.com") {
      const body: unknown = JSON.parse(String(init?.body));
      if (typeof body === "object" && body !== null && !Array.isArray(body)) {
        telegramBodies.push(body as Record<string, unknown>);
      }
      const text =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>).text
          : undefined;
      if (
        typeof text === "string"
      ) {
        telegramTexts.push(text);
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" },
      });
    }
    const body: unknown = JSON.parse(String(init?.body));
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      deepSeekBodies.push(Object.fromEntries(Object.entries(body)));
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(proposal) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return {
    fetcher,
    queue: { send: async () => undefined },
    now: () => NOW + 10,
    random: { nextUint32: () => 0xffff_ffff },
    busyProbabilityPercent: 0,
    dailyMessageLimit: 200,
  };
}

describe("confirmed persona correction flow", () => {
  it("creates only a sanitized 24-hour draft until exact confirmation", async () => {
    const rawTrigger = "她不会这样，她安慰时不会一开始讲道理";
    const { owner, message } = await fixture(rawTrigger);
    await processQueueMessage(
      {
        type: "chat",
        mode: "persona",
        ownerId: owner.ownerId,
        telegramUpdateId: 9001,
        messageId: message.messageId,
      },
      env,
      deps({
        summary: "安慰时先倾听，再提供建议",
        impactScope: "comfort.sequence",
        confidence: "high",
        operations: [
          {
            operation: "replace",
            path: "comfort.sequence",
            value: ["先听 OWNER 讲完", "表示理解", "再讨论建议"],
          },
        ],
      }),
    );

    expect((await getCurrentPersona(env.DB, owner.ownerId))?.version).toBe(1);
    const draft = await env.DB
      .prepare(
        `SELECT operation, summary, impact_scope, patch_json, expires_at
         FROM persona_change_drafts`,
      )
      .first<{
        operation: string;
        summary: string;
        impact_scope: string;
        patch_json: string;
        expires_at: number;
      }>();
    expect(draft).toMatchObject({
      operation: "correction",
      summary: "安慰时先倾听，再提供建议",
      impact_scope: "comfort.sequence",
      expires_at: NOW + 10 + 86_400,
    });
    expect(JSON.stringify(draft)).not.toContain(rawTrigger);

    const first = await handleOwnerCommand({
      db: env.DB,
      owner,
      text: CONFIRM_PERSONA_CORRECTION,
      now: NOW + 11,
      recoveryBaseUrl: "https://yuan.example",
    });
    expect(first.messages.join("\n")).toContain("v2");
    expect(first.messages.join("\n")).toContain("安慰时先倾听");
    const duplicate = await handleOwnerCommand({
      db: env.DB,
      owner,
      text: CONFIRM_PERSONA_CORRECTION,
      now: NOW + 12,
      recoveryBaseUrl: "https://yuan.example",
    });
    expect(duplicate.handled).toBe(true);
    expect((await getCurrentPersona(env.DB, owner.ownerId))?.version).toBe(2);
  });

  it("uses a separate addition confirmation and rejects unsafe paths", async () => {
    const { owner, message } = await fixture("新明确兴趣", "system");
    const deepSeekBodies: Array<Record<string, unknown>> = [];
    const telegramBodies: Array<Record<string, unknown>> = [];
    const addCommand = await handleOwnerCommand({
      db: env.DB,
      owner,
      text: "/persona-add 她后来明确表达了一个新兴趣",
      now: NOW + 5,
      recoveryBaseUrl: "https://yuan.example",
    });
    expect(addCommand).toMatchObject({
      enqueue: { mode: "persona_addition" },
    });

    await processQueueMessage(
      {
        type: "persona_draft",
        operation: "addition",
        ownerId: owner.ownerId,
        telegramUpdateId: 9001,
        messageId: message.messageId,
      },
      env,
      deps(
        {
          summary: "新增已明确表达的日常兴趣",
          impactScope: "interests.topics",
          confidence: "high",
          operations: [
            {
              operation: "add",
              path: "interests.topics",
              value: ["新兴趣"],
            },
          ],
        },
        deepSeekBodies,
        [],
        telegramBodies,
      ),
    );
    expect(deepSeekBodies[0]?.max_tokens).toBe(1_200);
    const additionDraftReply = await env.DB
      .prepare(
        "SELECT content FROM messages WHERE role = 'assistant' AND mode = 'system' ORDER BY id DESC LIMIT 1",
      )
      .first<{ content: string }>();
    expect(additionDraftReply?.content).toContain("实际写入：\n- interests.topics：新明确兴趣");
    expect(additionDraftReply?.content).not.toContain("新增已明确表达的日常兴趣");
    expect(additionDraftReply?.content).toContain("请使用下方按钮选择操作。");
    expect(additionDraftReply?.content).not.toContain("发送“确认新增”后才会生效");
    const telegramJson = JSON.stringify(telegramBodies);
    expect(telegramJson).toContain('"callback_data":"pd:c:');
    expect(telegramJson).toContain('"text":"确认新增"');
    expect(telegramJson).toContain('"text":"重新生成"');
    expect(telegramJson).toContain('"text":"手动修改"');
    expect(telegramJson).toContain('"text":"取消"');
    expect(
      await env.DB.prepare("SELECT source_message_id FROM persona_change_drafts").first(),
    ).toEqual({ source_message_id: message.messageId });
    expect(
      (
        await handleOwnerCommand({
          db: env.DB,
          owner,
          text: CONFIRM_PERSONA_ADDITION,
          now: NOW + 11,
          recoveryBaseUrl: "https://yuan.example",
        })
      ).messages.join("\n"),
    ).toContain("v2");

    await env.DB.exec("DELETE FROM persona_change_drafts; DELETE FROM processed_updates; DELETE FROM messages; DELETE FROM conversations;");
    const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW + 20);
    const failureTexts: string[] = [];
    await claimUpdate(env.DB, 9002, owner.ownerId, NOW + 21);
    const unsafeMessage = await appendMessage(env.DB, {
      ownerId: owner.ownerId,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "system",
      content: "unsafe",
      telegramUpdateId: 9002,
      createdAt: NOW + 21,
    });
    await markUpdate(env.DB, 9002, "queued", NOW + 21);
    await expect(
      processQueueMessage(
        {
          type: "persona_draft",
          operation: "addition",
          ownerId: owner.ownerId,
          telegramUpdateId: 9002,
          messageId: unsafeMessage.messageId,
        },
        env,
        deps(
          {
            summary: "unsafe",
            impactScope: "identity.displayName",
            confidence: "high",
            operations: [
              {
                operation: "replace",
                path: "identity.displayName",
                value: "Other",
              },
            ],
          },
          [],
          failureTexts,
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_persona_draft" });
    expect(failureTexts).toEqual([
      "人格草稿生成失败了，请稍后重新发送 /persona-add。",
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_change_drafts").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB
        .prepare(
          "SELECT status, last_error_code FROM processed_updates WHERE telegram_update_id = ?",
        )
        .bind(9002)
        .first(),
    ).toEqual({
      status: "failed",
      last_error_code: "invalid_persona_draft:operation_schema",
    });
  });
});
