import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  pairOwner,
  rebindOwner,
} from "../src/storage/owner-repository";
import { seedPersona } from "../src/storage/persona-repository";
import {
  appendMessage,
  getOrCreateActiveConversation,
} from "../src/storage/chat-repository";
import { saveMemoryExtraction } from "../src/storage/semantic-memory-repository";
import { saveRecallTrace } from "../src/storage/memory-recall-repository";

const NOW = 1_800_000_000;

async function signedInitData(overrides: Record<string, string> = {}): Promise<string> {
  const fields = new Map<string, string>([
    ["auth_date", String(Math.floor(Date.now() / 1_000))],
    ["query_id", "AAExample"],
    ["user", JSON.stringify({ id: 101, first_name: "OWNER" })],
    ...Object.entries(overrides),
  ]);
  const dataCheck = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const webAppSecret = new TextEncoder().encode("WebAppData");
  const secretKey = await crypto.subtle.importKey(
    "raw",
    webAppSecret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(dataCheck),
  ));
  fields.set("hash", [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  return new URLSearchParams(fields).toString();
}

async function appFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const login = await SELF.fetch("https://example.test/api/app/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: await signedInitData() }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie");
  if (cookie !== null) headers.set("cookie", cookie.split(";", 1)[0] ?? "");
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
    DELETE FROM owner_recovery;
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
  it("logs in only via the bound Telegram account and issues an HttpOnly session", async () => {
    const missing = await SELF.fetch("https://example.test/api/app/overview");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    const invalid = await SELF.fetch("https://example.test/api/app/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: "tampered-init-data" }),
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: "invalid_init_data" });
    const unbound = await SELF.fetch("https://example.test/api/app/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: await signedInitData({
        user: JSON.stringify({ id: 999, first_name: "Other" }),
      }) }),
    });
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toEqual({ error: "not_bound" });
    const login = await SELF.fetch("https://example.test/api/app/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: await signedInitData() }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  it("revokes an existing session after the owner rebinds to another Telegram account", async () => {
    const login = await SELF.fetch("https://example.test/api/app/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initData: await signedInitData() }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    if (cookie === null) return;
    const token = cookie.split(";", 1)[0] ?? "";
    const before = await SELF.fetch("https://example.test/api/app/overview", {
      headers: { cookie: token },
    });
    expect(before.status).toBe(200);
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    await rebindOwner(env.DB, owner!.id, 501, 501, NOW + 1);
    const after = await SELF.fetch("https://example.test/api/app/overview", {
      headers: { cookie: token },
    });
    expect(after.status).toBe(401);
  });

  it("returns owner overview and no-store headers", async () => {
    const response = await appFetch("/api/app/overview");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      currentPersonaVersion: 1,
      memoryCount: 1,
      episodeCount: 0,
      runtime: {
        status: "online",
        model: env.DEEPSEEK_MODEL,
        memory: "D1 + Vectorize",
      },
    });
  });

  it("lists and explains selected memory recalls without exposing the query", async () => {
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    const conversation = await getOrCreateActiveConversation(env.DB, owner!.id, NOW);
    const assistantMessage = await appendMessage(env.DB, {
      ownerId: owner!.id, conversationId: conversation.conversationId, role: "assistant",
      mode: "persona", content: "ok", telegramMessageId: 9001, telegramUpdateId: 9002,
      inputTokens: 0, outputTokens: 1, createdAt: NOW,
    });
    const traceId = await saveRecallTrace(env.DB, {
      ownerId: owner!.id,
      conversationId: conversation.conversationId,
      assistantMessageId: assistantMessage.messageId,
      queryHash: "a".repeat(64),
      explicitHistory: true,
      model: "deepseek-chat",
      personaVersion: 2,
      items: [{
        entityKind: "fact", entityId: 1, factKey: "study.plan", factValue: "准备考试",
        category: "study", confidence: "high", channel: "pinned", totalScore: 96,
        relevanceScore: 30, updatedAt: NOW, status: "active", control: "pinned",
        components: { relevance: 30, confidence: 20, recency: 10, control: 25, channel: 11, diversity: 0 },
        reasonCodes: ["pinned", "high_confidence"],
      }],
      now: NOW,
    });
    const listed = await appFetch("/api/app/memory-recalls");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: traceId, itemCount: 1 }] });
    const detail = await appFetch(`/api/app/memory-recalls/${traceId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      queryHash: "a".repeat(64),
      items: [{ factValue: "准备考试", reasonCodes: ["pinned", "high_confidence"] }],
    });
    expect((await appFetch("/api/app/memory-recalls/999999")).status).toBe(404);
  });

  it("lets only the owner confirm or reject Identity Core candidates", async () => {
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    const inserted = await env.DB.prepare(
      `INSERT INTO identity_candidates (owner_id, identity_key, identity_value, status, evidence_count, created_at, updated_at)
       VALUES (?, 'reasoning.style', '先讲理由，再给结论', 'ready', 2, ?, ?) RETURNING id`,
    ).bind(owner!.id, NOW, NOW).first<{ id: number }>();
    const listed = await appFetch("/api/app/identity-core");
    expect(await listed.json()).toMatchObject({ candidates: [{ id: inserted!.id, evidenceCount: 2 }] });
    expect((await appFetch(`/api/app/identity-core/${inserted!.id}/confirm`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT identity_value FROM identity_core_entries WHERE owner_id = ? AND status = 'active'").bind(owner!.id).first()).toEqual({ identity_value: "先讲理由，再给结论" });
    expect((await appFetch(`/api/app/identity-core/${inserted!.id}/reject`, { method: "POST", body: "{}" })).status).toBe(404);
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

  it("reads and updates proactive chat preferences", async () => {
    const defaults = await appFetch("/api/app/chat-preferences");
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toEqual({
      proactiveEnabled: true,
      dailyMin: 2,
      dailyMax: 3,
      quietStartMinute: null,
      quietEndMinute: null,
      pausedUntil: null,
      consecutiveUnanswered: 0,
    });

    const updated = await appFetch("/api/app/chat-preferences", {
      method: "PATCH",
      body: JSON.stringify({
        proactiveEnabled: true,
        dailyMin: 1,
        dailyMax: 2,
        quietStartMinute: 23 * 60,
        quietEndMinute: 7 * 60,
        pausedUntil: NOW + 86_400,
      }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      proactiveEnabled: true,
      dailyMin: 1,
      dailyMax: 2,
      quietStartMinute: 1380,
      quietEndMinute: 420,
      pausedUntil: NOW + 86_400,
    });
  });

  it("rejects invalid proactive chat preferences", async () => {
    const response = await appFetch("/api/app/chat-preferences", {
      method: "PATCH",
      body: JSON.stringify({
        proactiveEnabled: true,
        dailyMin: 3,
        dailyMax: 1,
        quietStartMinute: null,
        quietEndMinute: null,
        pausedUntil: null,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_chat_preferences" });
  });

  it("pins, ignores and restores a memory through the authenticated API", async () => {
    const memory = await env.DB.prepare("SELECT id FROM memory_facts").first<{ id: number }>();
    if (memory === null) throw new Error("memory_fixture_missing");
    for (const control of ["pinned", "ignored", "normal"]) {
      const response = await appFetch(`/api/app/memory-controls/fact/${memory.id}`, {
        method: "PATCH",
        body: JSON.stringify({ control }),
      });
      expect(response.status).toBe(200);
      expect(await env.DB.prepare(
        "SELECT control FROM memory_controls WHERE entity_kind = 'fact' AND entity_id = ?",
      ).bind(memory.id).first()).toEqual({ control });
    }
  });

  it("lists and deletes an episode from the management API", async () => {
    const owner = await env.DB.prepare("SELECT id FROM owners").first<{ id: number }>();
    if (owner === null) throw new Error("owner_missing");
    const episode = await env.DB.prepare(
      `INSERT INTO memory_episodes (
         owner_id, category, content, people_json, topics_json, occurred_at,
         auto_inject_until, created_at, updated_at
       ) VALUES (?, 'study', '考试前有些焦虑', '["OWNER"]', '["考试"]', ?, ?, ?, ?)
       RETURNING id`,
    ).bind(owner.id, NOW, NOW + 30 * 86_400, NOW, NOW).first<{ id: number }>();
    if (episode === null) throw new Error("episode_fixture_missing");

    const listed = await appFetch("/api/app/episodes?category=study");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: [{ id: episode.id, content: "考试前有些焦虑", people: ["OWNER"], topics: ["考试"] }],
    });

    const deleted = await appFetch(`/api/app/episodes/${episode.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedUpdatedAt: NOW }),
    });
    expect(deleted.status).toBe(200);
    expect(await env.DB.prepare(
      "SELECT operation, status FROM memory_vector_jobs WHERE entity_kind = 'episode' AND entity_id = ?",
    ).bind(episode.id).first()).toEqual({ operation: "delete", status: "pending" });
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
