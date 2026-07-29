import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pairOwner } from "../src/storage/owner-repository";
import {
  deleteMemory,
  getManagementOverview,
  listMemories,
  recordManagementEvent,
  updateMemory,
} from "../src/storage/management-repository";

const NOW = 1_800_000_000;

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM management_events;
    DELETE FROM memory_facts;
    DELETE FROM owners;
  `);
});

async function fixture(): Promise<{ ownerId: number; memoryId: number }> {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  const row = await env.DB.prepare(
    `INSERT INTO memory_facts (
       owner_id, category, fact_key, fact_value, confidence, created_at, updated_at
     ) VALUES (?, 'study', 'plan', 'OWNER 在准备考试', 'high', ?, ?)
     RETURNING id`,
  ).bind(owner.ownerId, NOW, NOW).first<{ id: number }>();
  if (row === null) throw new Error("memory_fixture_failed");
  return { ownerId: owner.ownerId, memoryId: row.id };
}

describe("management repository", () => {
  it("lists, searches, and summarizes owned memories", async () => {
    const { ownerId, memoryId } = await fixture();
    const page = await listMemories(env.DB, ownerId, {
      query: "考试",
      category: "study",
      limit: 10,
    });
    expect(page.items).toEqual([
      expect.objectContaining({ id: memoryId, factValue: "OWNER 在准备考试" }),
    ]);
    await expect(getManagementOverview(env.DB, ownerId)).resolves.toMatchObject({
      memoryCount: 1,
      memoryByCategory: { study: 1 },
    });
  });

  it("updates only an owned memory with optimistic updated_at", async () => {
    const { ownerId, memoryId } = await fixture();
    await expect(updateMemory(env.DB, ownerId, memoryId, {
      category: "goal",
      factValue: "OWNER 想继续读研",
      confidence: "medium",
      expectedUpdatedAt: NOW,
      now: NOW + 1,
    })).resolves.toEqual({ ok: true, updatedAt: NOW + 1 });
    expect(await env.DB.prepare(
      "SELECT operation, status FROM memory_vector_jobs WHERE owner_id = ? AND entity_kind = 'fact' AND entity_id = ?",
    ).bind(ownerId, memoryId).first()).toEqual({ operation: "upsert", status: "pending" });
    await expect(updateMemory(env.DB, ownerId, memoryId, {
      category: "goal",
      factValue: "stale",
      confidence: "medium",
      expectedUpdatedAt: NOW,
      now: NOW + 2,
    })).resolves.toEqual({ ok: false, reason: "not_found_or_conflict" });
  });

  it("deletes only an owned memory and records metadata-only events", async () => {
    const { ownerId, memoryId } = await fixture();
    expect(await deleteMemory(env.DB, ownerId, memoryId, NOW, NOW + 1)).toBe(true);
    expect(await env.DB.prepare(
      "SELECT operation, status FROM memory_vector_jobs WHERE owner_id = ? AND entity_kind = 'fact' AND entity_id = ?",
    ).bind(ownerId, memoryId).first()).toEqual({ operation: "delete", status: "pending" });
    await recordManagementEvent(env.DB, {
      ownerId,
      action: "delete",
      resourceType: "memory",
      resourceId: String(memoryId),
      result: "ok",
      now: NOW + 1,
    });
    expect(await env.DB.prepare(
      "SELECT action, resource_type, resource_id, result FROM management_events",
    ).first()).toEqual({
      action: "delete",
      resource_type: "memory",
      resource_id: String(memoryId),
      result: "ok",
    });
  });
});
