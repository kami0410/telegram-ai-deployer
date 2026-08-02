import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { pairOwner } from "../src/storage/owner-repository";
import { getQualityEventStats, recordQualityEvent } from "../src/quality-events";
const NOW = 1_800_000_000;
beforeEach(async () => { await env.DB.exec("DELETE FROM quality_events; DELETE FROM owners;"); });
it("stores aggregate integer metrics and rejects private payload-shaped fields", async () => {
  const owner = await pairOwner(env.DB, 1, 1, NOW); if (!owner) throw new Error("owner");
  await recordQualityEvent(env, { ownerId: owner.ownerId, category: "retrieval", reasonCode: "hybrid_success", metrics: { selected_count: 3 }, modelVersion: "flash", personaVersion: 8, workerVersion: "candidate", now: NOW });
  expect(await getQualityEventStats(env.DB, owner.ownerId, NOW - 1)).toEqual([{ category: "retrieval", reasonCode: "hybrid_success", count: 1 }]);
  await expect(recordQualityEvent(env, { ownerId: owner.ownerId, category: "error", reasonCode: "bad", metrics: { message_body: 1 }, modelVersion: "flash", personaVersion: 8, workerVersion: "candidate", now: NOW })).rejects.toThrow("quality_event_metrics_invalid");
});
