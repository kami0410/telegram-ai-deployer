import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { PERSONA_V1 } from "../src/persona/seed";
import { pairOwner } from "../src/storage/owner-repository";
import {
  getCurrentPersona,
  seedPersona,
} from "../src/storage/persona-repository";

const NOW = 1_750_000_000;

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

describe("approved Persona persona seed", () => {
  it("contains the required identity, behavior, uncertainty, and safety layers", () => {
    expect(PERSONA_V1.schemaVersion).toBe(1);
    expect(PERSONA_V1.identity.displayName).toBe("Persona Bot");
    expect(PERSONA_V1.identity.ownerName).toBe("Owner");
    expect(PERSONA_V1.openingPhrase).toBe("How have you been?");
    expect(PERSONA_V1.identity.consentConfirmed).toBe(true);
    expect(PERSONA_V1.realityBoundaries.join(" ")).toContain("not a real person");
    expect(PERSONA_V1.realityBoundaries.join(" ")).toContain(
      "Never claim real-world actions",
    );
    expect(PERSONA_V1.safetyRules.join(" ")).toContain("self-harm");
    expect(PERSONA_V1.safetyRules.join(" ")).toContain("recommend real-world help");
    expect(PERSONA_V1.expression.markers).toEqual([]);
    expect(PERSONA_V1.comfort.opening).toBe("What happened?");
    expect(PERSONA_V1.intimacy.rules.join(" ")).toContain(
      "Respect boundaries and avoid unsupported romantic claims",
    );
    expect(PERSONA_V1.intimacy.prohibitedTerms).toEqual([]);
    expect(PERSONA_V1.uncertainty.unknowns.join(" ")).toContain(
      "Any fact not explicitly provided by the owner",
    );
  });

  it("contains no excluded source details or captured private artifacts", () => {
    const serialized = JSON.stringify(PERSONA_V1);
    const excludedPatterns = [
      "codex-clipboard",
      "AppData",
      "Temp",
      "2024年10月29日",
      "南京",
      "哈尔滨",
      "985",
      "100分",
      "汤圆儿",
      "司天",
    ];

    for (const pattern of excludedPatterns) {
      expect(serialized).not.toContain(pattern);
    }
  });

  it("seeds version one once using a stable canonical hash", async () => {
    const owner = await pairOwner(env.DB, 101, 201, NOW);
    expect(owner).not.toBeNull();
    if (owner === null) return;

    const first = await seedPersona(env.DB, owner.ownerId, NOW + 1);
    const second = await seedPersona(env.DB, owner.ownerId, NOW + 2);

    expect(first.version).toBe(1);
    expect(first.snapshot).toEqual(PERSONA_V1);
    expect(first.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual(first);
    expect(await getCurrentPersona(env.DB, owner.ownerId)).toEqual(first);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_versions").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM persona_version_events").first(),
    ).toEqual({ count: 1 });
  });
});
