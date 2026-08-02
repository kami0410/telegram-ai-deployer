import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { processQueueMessage, type QueueDependencies } from "../src/queue";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { pairOwner } from "../src/storage/owner-repository";
import { seedPersona } from "../src/storage/persona-repository";
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

it("keeps /ask prompts and answers out of Persona persona and memory", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  expect(owner).not.toBeNull();
  if (owner === null) return;
  await seedPersona(env.DB, owner.ownerId, NOW + 1);
  const conversation = await getOrCreateActiveConversation(env.DB, owner.ownerId, NOW + 2);
  await claimUpdate(env.DB, 9001, owner.ownerId, NOW + 3);
  const message = await appendMessage(env.DB, {
    ownerId: owner.ownerId,
    conversationId: conversation.conversationId,
    role: "user",
    mode: "ask",
    content: "麦克斯韦方程组是什么",
    telegramUpdateId: 9001,
    createdAt: NOW + 3,
  });
  await markUpdate(env.DB, 9001, "queued", NOW + 3);
  const bodies: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    bodies.push(String(init?.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "这是一组描述电磁场的方程。" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  const dependencies: QueueDependencies = {
    fetcher,
    queue: { send: async () => undefined },
    now: () => NOW + 10,
    random: { nextUint32: () => 0xffff_ffff },
    busyProbabilityPercent: 0,
    dailyMessageLimit: 200,
  };

  await processQueueMessage(
    {
      type: "chat",
      mode: "ask",
      ownerId: owner.ownerId,
      telegramUpdateId: 9001,
      messageId: message.messageId,
    },
    env,
    dependencies,
  );

  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    model: env.DEEPSEEK_MODEL,
    thinking: { type: "enabled" },
  });
  expect(bodies[0]).toContain("[ASK_MODE_NON_LEARNING]");
  expect(bodies[0]).not.toContain("Persona 与 OWNER");
  expect(bodies[0]).not.toContain("🌚");
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_versions").first(),
  ).toEqual({ count: 1 });
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS count FROM memory_facts").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.DB.prepare("SELECT mode FROM messages WHERE role = 'assistant'").first(),
  ).toEqual({ mode: "ask" });
});
