import { describe, expect, it } from "vitest";
import { PERSONA_V1, canonicalPersonaJson, parsePersonaSnapshot } from "../src/persona/seed";

describe("generic persona seed", () => {
  it("contains safety and reality boundaries without private facts", () => {
    expect(PERSONA_V1.schemaVersion).toBe(1);
    expect(PERSONA_V1.identity.displayName).toBe("Persona Bot");
    expect(PERSONA_V1.identity.ownerName).toBe("Owner");
    expect(PERSONA_V1.relationship.confidenceFacts).toEqual([]);
    expect(PERSONA_V1.realityBoundaries.join(" ")).toContain("not a real person");
    expect(PERSONA_V1.safetyRules.join(" ")).toContain("self-harm");
    expect(PERSONA_V1.interests.publicFigures).toEqual([]);
  });

  it("round-trips through canonical JSON", () => {
    const serialized = canonicalPersonaJson(PERSONA_V1);
    expect(parsePersonaSnapshot(serialized)).toEqual(PERSONA_V1);
    expect(serialized).not.toMatch(/https?:\/\//u);
  });
});
