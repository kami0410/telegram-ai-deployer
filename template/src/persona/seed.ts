import personaV1Json from "./persona-v1.json";

export interface PersonaSnapshot {
  schemaVersion: number;
  sourceVersion: string;
  identity: {
    displayName: string;
    ownerName: string;
    singleOwnerOnly: boolean;
    consentConfirmed: boolean;
    showAiReminderInDailyChat: boolean;
  };
  priorities: string[];
  realityBoundaries: string[];
  safetyRules: string[];
  relationship: {
    confidenceFacts: string[];
    rules: string[];
    meetingRules: string[];
  };
  coreTraits: { labels: string[]; rules: string[] };
  expression: {
    markers: string[];
    phraseEndings: string[];
    rules: string[];
    prohibited: string[];
  };
  comfort: { opening: string; sequence: string[]; rules: string[] };
  advice: { rules: string[] };
  viewOfOwner: { rules: string[] };
  interests: { topics: string[]; publicFigures: string[]; rules: string[] };
  uncertainty: { unknowns: string[]; prohibitedInferences: string[] };
  intimacy: { rules: string[]; prohibitedTerms: string[] };
  rhythm: { rules: string[] };
  proactive: { rules: string[] };
  knowledge: { rules: string[] };
  openingPhrase: string;
}

export const PERSONA_V1: PersonaSnapshot = personaV1Json;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;

  const sorted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[key] = canonicalize(entry);
  }
  return sorted;
}

export function canonicalPersonaJson(snapshot: PersonaSnapshot): string {
  return JSON.stringify(canonicalize(snapshot));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error("invalid_persona_snapshot");
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error("invalid_persona_snapshot");
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error("invalid_persona_snapshot");
  return value;
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("invalid_persona_snapshot");
  }
  return [...value];
}

export function parsePersonaSnapshot(json: string): PersonaSnapshot {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error("invalid_persona_snapshot");
  }
  const identity = requireRecord(parsed, "identity");
  const relationship = requireRecord(parsed, "relationship");
  const coreTraits = requireRecord(parsed, "coreTraits");
  const expression = requireRecord(parsed, "expression");
  const comfort = requireRecord(parsed, "comfort");
  const advice = requireRecord(parsed, "advice");
  const viewOfOwner = requireRecord(parsed, "viewOfOwner");
  const interests = requireRecord(parsed, "interests");
  const uncertainty = requireRecord(parsed, "uncertainty");
  const intimacy = requireRecord(parsed, "intimacy");
  const rhythm = requireRecord(parsed, "rhythm");
  const proactive = requireRecord(parsed, "proactive");
  const knowledge = requireRecord(parsed, "knowledge");

  return {
    schemaVersion: 1,
    sourceVersion: requireString(parsed, "sourceVersion"),
    identity: {
      displayName: requireString(identity, "displayName"),
      ownerName: requireString(identity, "ownerName"),
      singleOwnerOnly: requireBoolean(identity, "singleOwnerOnly"),
      consentConfirmed: requireBoolean(identity, "consentConfirmed"),
      showAiReminderInDailyChat: requireBoolean(
        identity,
        "showAiReminderInDailyChat",
      ),
    },
    priorities: requireStringArray(parsed, "priorities"),
    realityBoundaries: requireStringArray(parsed, "realityBoundaries"),
    safetyRules: requireStringArray(parsed, "safetyRules"),
    relationship: {
      confidenceFacts: requireStringArray(relationship, "confidenceFacts"),
      rules: requireStringArray(relationship, "rules"),
      meetingRules: requireStringArray(relationship, "meetingRules"),
    },
    coreTraits: {
      labels: requireStringArray(coreTraits, "labels"),
      rules: requireStringArray(coreTraits, "rules"),
    },
    expression: {
      markers: requireStringArray(expression, "markers"),
      phraseEndings: requireStringArray(expression, "phraseEndings"),
      rules: requireStringArray(expression, "rules"),
      prohibited: requireStringArray(expression, "prohibited"),
    },
    comfort: {
      opening: requireString(comfort, "opening"),
      sequence: requireStringArray(comfort, "sequence"),
      rules: requireStringArray(comfort, "rules"),
    },
    advice: { rules: requireStringArray(advice, "rules") },
    viewOfOwner: { rules: requireStringArray(viewOfOwner, "rules") },
    interests: {
      topics: requireStringArray(interests, "topics"),
      publicFigures: requireStringArray(interests, "publicFigures"),
      rules: requireStringArray(interests, "rules"),
    },
    uncertainty: {
      unknowns: requireStringArray(uncertainty, "unknowns"),
      prohibitedInferences: requireStringArray(
        uncertainty,
        "prohibitedInferences",
      ),
    },
    intimacy: {
      rules: requireStringArray(intimacy, "rules"),
      prohibitedTerms: requireStringArray(intimacy, "prohibitedTerms"),
    },
    rhythm: { rules: requireStringArray(rhythm, "rules") },
    proactive: { rules: requireStringArray(proactive, "rules") },
    knowledge: { rules: requireStringArray(knowledge, "rules") },
    openingPhrase: requireString(parsed, "openingPhrase"),
  };
}
