import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pairOwner } from "../src/storage/owner-repository";
import {
  confirmPersonaDraft,
  createPersonaDraft,
  deletePersona,
  getCurrentPersona,
  rollbackPersona,
  seedPersona,
} from "../src/storage/persona-repository";

const NOW = 1_750_000_000;

async function seededOwner(): Promise<number> {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  expect(owner).not.toBeNull();
  if (owner === null) throw new Error("owner_fixture_failed");
  await seedPersona(env.DB, owner.ownerId, NOW + 1);
  return owner.ownerId;
}

beforeEach(async () => {
  await env.DB.exec(`
    DELETE FROM persona_runtime_state;
    DELETE FROM persona_version_events;
    DELETE FROM persona_change_drafts;
    DELETE FROM persona_versions;
    DELETE FROM persona_profiles;
    DELETE FROM owners;
  `);
});

describe("immutable persona versions", () => {
  it("confirms only allowlisted patches into a new immutable version", async () => {
    const ownerId = await seededOwner();
    const before = await getCurrentPersona(env.DB, ownerId);
    expect(before).not.toBeNull();
    if (before === null) return;

    const markers = [...before.snapshot.expression.markers, "虽然。也没多少人听"];
    const draft = await createPersonaDraft(env.DB, {
      ownerId,
      operation: "correction",
      summary: "补充已确认的停顿语气",
      impactScope: "expression.markers",
      patch: [{ path: "expression.markers", value: markers }],
      now: NOW + 2,
    });
    expect(draft.expiresAt).toBe(NOW + 2 + 86_400);

    const confirmed = await confirmPersonaDraft(
      env.DB,
      ownerId,
      draft.draftId,
      NOW + 3,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.persona.version).toBe(2);
    expect(confirmed.persona.snapshot.expression.markers).toContain(
      "虽然。也没多少人听",
    );

    const original = await env.DB
      .prepare(
        "SELECT snapshot_json FROM persona_versions WHERE owner_id = ? AND version = 1",
      )
      .bind(ownerId)
      .first<{ snapshot_json: string }>();
    expect(original).not.toBeNull();
    if (original === null) return;
    expect(JSON.parse(original.snapshot_json)).toEqual(before.snapshot);
  });

  it("rejects edits to identity and hard reality boundaries", async () => {
    const ownerId = await seededOwner();

    await expect(
      createPersonaDraft(env.DB, {
        ownerId,
        operation: "correction",
        summary: "unsafe fixture",
        impactScope: "identity",
        patch: [{ path: "identity.displayName", value: ["Other"] }],
        now: NOW + 2,
      }),
    ).rejects.toThrow("persona_patch_path_not_allowed");
    await expect(
      createPersonaDraft(env.DB, {
        ownerId,
        operation: "addition",
        summary: "unsafe fixture",
        impactScope: "reality",
        patch: [{ path: "realityBoundaries", value: [] }],
        now: NOW + 2,
      }),
    ).rejects.toThrow("persona_patch_path_not_allowed");
  });

  it("does not confirm expired drafts", async () => {
    const ownerId = await seededOwner();
    const draft = await createPersonaDraft(env.DB, {
      ownerId,
      operation: "addition",
      summary: "fixture",
      impactScope: "interests.topics",
      patch: [
        {
          path: "interests.topics",
          value: ["学习", "日常琐事", "朋友见闻", "未来计划", "新话题"],
        },
      ],
      now: NOW + 2,
    });

    expect(
      await confirmPersonaDraft(
        env.DB,
        ownerId,
        draft.draftId,
        draft.expiresAt + 1,
      ),
    ).toEqual({ ok: false, reason: "not_found_or_expired" });
    expect((await getCurrentPersona(env.DB, ownerId))?.version).toBe(1);
  });

  it("rolls back by copying a historical snapshot into a higher version", async () => {
    const ownerId = await seededOwner();
    const v1 = await getCurrentPersona(env.DB, ownerId);
    expect(v1).not.toBeNull();
    if (v1 === null) return;

    const draft = await createPersonaDraft(env.DB, {
      ownerId,
      operation: "correction",
      summary: "fixture change",
      impactScope: "expression.markers",
      patch: [
        {
          path: "expression.markers",
          value: [...v1.snapshot.expression.markers, "fixture marker"],
        },
      ],
      now: NOW + 2,
    });
    expect(
      (
        await confirmPersonaDraft(
          env.DB,
          ownerId,
          draft.draftId,
          NOW + 3,
        )
      ).ok,
    ).toBe(true);

    const rollback = await rollbackPersona(
      env.DB,
      ownerId,
      1,
      "回滚到已批准的初始版本",
      NOW + 4,
    );
    expect(rollback.ok).toBe(true);
    if (!rollback.ok) return;
    expect(rollback.persona.version).toBe(3);
    expect(rollback.persona.snapshot).toEqual(v1.snapshot);
    expect(rollback.persona.snapshotHash).toBe(v1.snapshotHash);
  });

  it("deletes the profile, versions, drafts, events, and runtime state", async () => {
    const ownerId = await seededOwner();
    await createPersonaDraft(env.DB, {
      ownerId,
      operation: "addition",
      summary: "fixture",
      impactScope: "interests.topics",
      patch: [{ path: "interests.topics", value: ["学习"] }],
      now: NOW + 2,
    });
    await env.DB
      .prepare(
        `INSERT INTO persona_runtime_state (owner_id, updated_at)
         VALUES (?, ?)`,
      )
      .bind(ownerId, NOW + 2)
      .run();

    expect(await deletePersona(env.DB, ownerId)).toBe(true);
    for (const table of [
      "persona_profiles",
      "persona_versions",
      "persona_change_drafts",
      "persona_version_events",
      "persona_runtime_state",
    ]) {
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first(),
      ).toEqual({ count: 0 });
    }
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM owners").first(),
    ).toEqual({ count: 1 });
  });
});
