import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getOwner,
  pairOwner,
  rebindOwner,
} from "../src/storage/owner-repository";
import {
  claimUpdate,
  markUpdate,
} from "../src/storage/update-repository";

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM processed_updates; DELETE FROM owners;",
  );
});

describe("stable owner identity", () => {
  it("pairs exactly one owner", async () => {
    const owner = await pairOwner(env.DB, 101, 201, 1_700_000_000);

    expect(owner).toMatchObject({
      telegramUserId: 101,
      telegramChatId: 201,
    });
    expect(await pairOwner(env.DB, 102, 202, 1_700_000_001)).toBeNull();
    expect(await getOwner(env.DB)).toEqual(owner);
  });

  it("keeps the internal owner id while rebinding Telegram", async () => {
    const owner = await pairOwner(env.DB, 101, 201, 1_700_000_000);
    expect(owner).not.toBeNull();
    if (owner === null) return;

    expect(
      await rebindOwner(env.DB, owner.ownerId, 102, 202, 1_700_000_100),
    ).toBe(true);
    expect(await getOwner(env.DB)).toEqual({
      ownerId: owner.ownerId,
      telegramUserId: 102,
      telegramChatId: 202,
      pairedAt: 1_700_000_000,
      migratedAt: 1_700_000_100,
    });
  });
});

describe("Telegram Update idempotency", () => {
  it("classifies new, recoverable, and duplicate states", async () => {
    const owner = await pairOwner(env.DB, 101, 201, 1_700_000_000);
    expect(owner).not.toBeNull();
    if (owner === null) return;

    expect(
      await claimUpdate(env.DB, 9001, owner.ownerId, 1_700_000_001),
    ).toBe("new");

    await markUpdate(env.DB, 9001, "queued", 1_700_000_002);
    expect(
      await claimUpdate(env.DB, 9001, owner.ownerId, 1_700_000_003),
    ).toBe("duplicate");

    await markUpdate(env.DB, 9001, "received", 1_700_000_004);
    expect(
      await claimUpdate(env.DB, 9001, owner.ownerId, 1_700_000_005),
    ).toBe("requeue");

    await markUpdate(env.DB, 9001, "failed", 1_700_000_006, "upstream_5xx");
    expect(
      await claimUpdate(env.DB, 9001, owner.ownerId, 1_700_000_007),
    ).toBe("requeue");
  });
});
