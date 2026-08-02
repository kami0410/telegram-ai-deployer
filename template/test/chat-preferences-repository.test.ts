import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { pairOwner } from "../src/storage/owner-repository";
import {
  getChatPreferences,
  isProactiveAllowedNow,
  noteProactiveSent,
  noteUserReply,
  updateChatPreferences,
} from "../src/storage/chat-preferences-repository";

const NOW = 1_750_000_000;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM owner_chat_preferences; DELETE FROM owners;");
});

it("uses the existing 2-3 daily behavior as the default", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  expect(await getChatPreferences(env.DB, owner.ownerId)).toEqual({
    proactiveEnabled: true,
    dailyMin: 2,
    dailyMax: 3,
    quietStartMinute: null,
    quietEndMinute: null,
    pausedUntil: null,
    consecutiveUnanswered: 0,
  });
});

it("supports disable, Beijing quiet hours, pause and unanswered reduction", async () => {
  const owner = await pairOwner(env.DB, 101, 201, NOW);
  if (owner === null) throw new Error("owner_fixture_failed");
  await updateChatPreferences(env.DB, owner.ownerId, {
    proactiveEnabled: true,
    dailyMin: 1,
    dailyMax: 3,
    quietStartMinute: 23 * 60,
    quietEndMinute: 7 * 60,
    pausedUntil: null,
  }, NOW);
  const atBeijingMidnight = Date.UTC(2026, 7, 1, 16, 30) / 1_000;
  expect(await isProactiveAllowedNow(env.DB, owner.ownerId, atBeijingMidnight)).toBe(false);
  await noteProactiveSent(env.DB, owner.ownerId, NOW + 1);
  await noteProactiveSent(env.DB, owner.ownerId, NOW + 2);
  expect((await getChatPreferences(env.DB, owner.ownerId)).consecutiveUnanswered).toBe(2);
  await noteUserReply(env.DB, owner.ownerId, NOW + 3);
  expect((await getChatPreferences(env.DB, owner.ownerId)).consecutiveUnanswered).toBe(0);
});
