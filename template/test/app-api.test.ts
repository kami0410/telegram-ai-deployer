import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { pairOwner } from "../src/storage/owner-repository";
import { seedPersona } from "../src/storage/persona-repository";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { saveMemoryExtraction } from "../src/storage/semantic-memory-repository";

const NOW = 1_800_000_000;

async function hmac(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));
}

async function initData(userId = 101): Promise<string> {
  const params = new Map([
    ["auth_date", String(Math.floor(Date.now() / 1_000))],
    ["user", JSON.stringify({ id: userId, first_name: "OWNER" })],
  ]);
  const checked = [...params.entries()].sort().map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), env.TELEGRAM_BOT_TOKEN);
  const signed = new Uint8Array(await hmac(secret, checked));
  params.set("hash", [...signed].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  return new URLSearchParams(params).toString();
}

async function appFetch(path: string, init: RequestInit = {}, userId = 101): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("telegram-init-data", await initData(userId));
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return SELF.fetch(`https://example.test${path}`, { ...init, headers });
}

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM management_events;
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM memory_facts;
    DELETE FROM owners;
  `);
  const owner = await pairOwner(env.DB, 101, 101, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  await seedPersona(env.DB, owner.ownerId, NOW);
  await env.DB.prepare(
    `INSERT INTO memory_facts (
       owner_id, category, fact_key, fact_value, confidence, created_at, updated_at
     ) VALUES (?, 'study', 'plan', 'OWNER 在准备考试', 'high', ?, ?)`,
  ).bind(owner.ownerId, NOW, NOW).run();
});

describe("management API", () => {
  it("rejects missing or wrong owner initData without leaking state", async () => {
    const missing = await SELF.fetch("https://example.test/api/app/overview");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    const wrong = await appFetch("/api/app/overview", {}, 999);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "forbidden" });
  });

  it("returns owner overview and no-store headers", async () => {
    const response = await appFetch("/api/app/overview");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      currentPersonaVersion: 1,
      memoryCount: 1,
    });
  });

  it("edits a memory and rejects stale writes", async () => {
    const memory = await env.DB.prepare("SELECT id FROM memory_facts").first<{ id: number }>();
    if (memory === null) throw new Error("memory_fixture_missing");
    const body = JSON.stringify({
      category: "goal",
      factValue: "OWNER 想继续读研",
      confidence: "medium",
      expectedUpdatedAt: NOW,
    });
    const first = await appFetch(`/api/app/memories/${memory.id}`, { method: "PATCH", body });
    expect(first.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT operation, status FROM memory_vector_jobs WHERE entity_kind = 'fact' AND entity_id = ?",
    ).bind(memory.id).first()).toEqual({ operation: "upsert", status: "pending" });
    const stale = await appFetch(`/api/app/memories/${memory.id}`, { method: "PATCH", body });
    expect(stale.status).toBe(409);
  });

  it("queues vector deletion when a memory is deleted", async () => {
    const memory = await env.DB.prepare("SELECT id FROM memory_facts").first<{ id: number }>();
    if (memory === null) throw new Error("memory_fixture_missing");
    const response = await appFetch(`/api/app/memories/${memory.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedUpdatedAt: NOW }),
    });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT operation, status FROM memory_vector_jobs WHERE entity_kind = 'fact' AND entity_id = ?",
    ).bind(memory.id).first()).toEqual({ operation: "delete", status: "pending" });
  });

  it("lists and deletes an episode from the management API", async () => {
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    if (owner === null) throw new Error("owner_missing");
    const episode = await env.DB.prepare(
      `INSERT INTO memory_episodes (owner_id, category, content, people_json, topics_json, occurred_at, auto_inject_until, created_at, updated_at)
       VALUES (?, 'study', '考试前有些焦虑', '["OWNER"]', '["考试"]', ?, ?, ?, ?) RETURNING id`,
    ).bind(owner.id, NOW, NOW + 30 * 86_400, NOW, NOW).first<{ id: number }>();
    if (episode === null) throw new Error("episode_fixture_missing");
    const listed = await appFetch("/api/app/episodes?category=study");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: episode.id, content: "考试前有些焦虑" }] });
    const deleted = await appFetch(`/api/app/episodes/${episode.id}`, { method: "DELETE", body: JSON.stringify({ expectedUpdatedAt: NOW }) });
    expect(deleted.status).toBe(200);
    expect(await env.DB.prepare("SELECT operation FROM memory_vector_jobs WHERE entity_kind = 'episode' AND entity_id = ?").bind(episode.id).first()).toEqual({ operation: "delete" });
  });

  it("loads and manually edits a pending memory conflict", async () => {
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    if (owner === null) throw new Error("owner_missing");
    const conversation = await getOrCreateActiveConversation(env.DB, owner.id, NOW + 1);
    const source = await appendMessage(env.DB, {
      ownerId: owner.id,
      conversationId: conversation.conversationId,
      role: "user",
      mode: "persona",
      content: "我现在准备考研",
      createdAt: NOW + 1,
    });
    const changed = await saveMemoryExtraction(env.DB, {
      ownerId: owner.id,
      conversationId: conversation.conversationId,
      stableFacts: [{
        category: "goal",
        factKey: "plan",
        factValue: "OWNER 现在准备考研",
        confidence: "high",
        sourceMessageId: source.messageId,
      }],
      episodes: [],
      now: NOW + 2,
    });
    const id = changed.conflicts[0]!.conflictId;
    const loaded = await appFetch(`/api/app/memory-conflicts/${id}`);
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({ candidateFactValue: "OWNER 现在准备考研" });

    const edited = await appFetch(`/api/app/memory-conflicts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        category: "goal",
        factValue: "OWNER 正在认真准备研究生考试",
        confidence: "high",
      }),
    });
    expect(edited.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT candidate_fact_value FROM memory_conflicts WHERE id = ?",
    ).bind(id).first()).toEqual({ candidate_fact_value: "OWNER 正在认真准备研究生考试" });
  });

  it("exports no chat transcript or secret fields", async () => {
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    if (owner === null) throw new Error("owner_missing");
    await env.DB.prepare(
      `INSERT INTO memory_episodes (
         owner_id, category, content, people_json, topics_json, occurred_at,
         auto_inject_until, created_at, updated_at
       ) VALUES (?, 'study', '考试前有些焦虑', '["OWNER"]', '["考试"]', ?, ?, ?, ?)`,
    ).bind(owner.id, NOW, NOW + 30 * 86_400, NOW, NOW).run();
    const response = await appFetch("/api/app/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const text = await response.text();
    expect(text).toContain("OWNER 在准备考试");
    expect(text).toContain("考试前有些焦虑");
    expect(text).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(text).not.toContain("messages");
  });
});
