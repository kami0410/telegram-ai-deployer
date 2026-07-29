import {
  canonicalPersonaJson,
  parsePersonaSnapshot,
  type PersonaSnapshot,
  PERSONA_V1,
} from "../persona/seed";
import { randomId, sha256Hex } from "../security";

const DRAFT_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_PATCH_BYTES = 16 * 1_024;

export interface CurrentPersona {
  ownerId: number;
  version: number;
  snapshot: PersonaSnapshot;
  snapshotHash: string;
  changeSummary: string;
  enabled: boolean;
  consentStatus: "confirmed" | "withdrawn";
}

export interface PersonaPatchInput {
  path: string;
  value: unknown;
}

interface NormalizedPersonaPatch {
  path: AllowedPatchPath;
  value: string | string[];
}

export interface CreatePersonaDraftInput {
  ownerId: number;
  operation: "correction" | "addition";
  summary: string;
  impactScope: string;
  patch: PersonaPatchInput[];
  sourceMessageId?: number | null;
  now: number;
}

export interface PersonaDraftReference {
  draftId: string;
  expiresAt: number;
}

export async function replacePersonaDraft(
  db: D1Database,
  ownerId: number,
  draftId: string,
  input: {
    summary: string;
    impactScope: string;
    patch: PersonaPatchInput[];
    now: number;
  },
): Promise<PersonaDraftReference | null> {
  if (
    input.summary.trim().length === 0 || input.summary.length > 500 ||
    input.impactScope.trim().length === 0 || input.impactScope.length > 200
  ) throw new Error("persona_draft_metadata_invalid");
  const normalized = normalizePatch(input.patch);
  const existing = await db.prepare(
    `SELECT operation, source_message_id FROM persona_change_drafts
     WHERE id = ? AND owner_id = ? AND expires_at >= ?`,
  ).bind(draftId, ownerId, input.now).first<{
    operation: "correction" | "addition";
    source_message_id: number | null;
  }>();
  if (existing === null) return null;
  const replacementId = randomId();
  const expiresAt = input.now + DRAFT_LIFETIME_SECONDS;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO persona_change_drafts (
         id, owner_id, operation, summary, impact_scope, patch_json,
         source_message_id, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      replacementId, ownerId, existing.operation, input.summary.trim(),
      input.impactScope.trim(), JSON.stringify(normalized), existing.source_message_id,
      expiresAt, input.now,
    ),
    db.prepare(
      "DELETE FROM persona_change_drafts WHERE id = ? AND owner_id = ? AND expires_at >= ?",
    ).bind(draftId, ownerId, input.now),
  ]);
  if (!batchSucceeded(results) || results.some((result) => changes(result) !== 1)) {
    throw new Error("persona_draft_replace_failed");
  }
  return { draftId: replacementId, expiresAt };
}

export type PersonaMutationResult =
  | { ok: true; persona: CurrentPersona }
  | { ok: false; reason: "not_found_or_expired" | "version_conflict" };

type AllowedPatchPath =
  | "relationship.confidenceFacts"
  | "relationship.rules"
  | "relationship.meetingRules"
  | "coreTraits.labels"
  | "coreTraits.rules"
  | "expression.markers"
  | "expression.phraseEndings"
  | "expression.rules"
  | "expression.prohibited"
  | "comfort.opening"
  | "comfort.sequence"
  | "comfort.rules"
  | "advice.rules"
  | "viewOfOwner.rules"
  | "interests.topics"
  | "interests.publicFigures"
  | "interests.rules"
  | "uncertainty.unknowns"
  | "uncertainty.prohibitedInferences"
  | "intimacy.rules"
  | "intimacy.prohibitedTerms"
  | "rhythm.rules"
  | "proactive.rules"
  | "knowledge.rules";

const ALLOWED_PATCH_PATHS = new Set<string>([
  "relationship.confidenceFacts",
  "relationship.rules",
  "relationship.meetingRules",
  "coreTraits.labels",
  "coreTraits.rules",
  "expression.markers",
  "expression.phraseEndings",
  "expression.rules",
  "expression.prohibited",
  "comfort.opening",
  "comfort.sequence",
  "comfort.rules",
  "advice.rules",
  "viewOfOwner.rules",
  "interests.topics",
  "interests.publicFigures",
  "interests.rules",
  "uncertainty.unknowns",
  "uncertainty.prohibitedInferences",
  "intimacy.rules",
  "intimacy.prohibitedTerms",
  "rhythm.rules",
  "proactive.rules",
  "knowledge.rules",
]);

interface CurrentPersonaRow {
  owner_id: number;
  current_version: number;
  enabled: number;
  consent_status: "confirmed" | "withdrawn";
  snapshot_json: string;
  snapshot_sha256: string;
  change_summary: string;
}

interface DraftRow {
  operation: "correction" | "addition";
  summary: string;
  patch_json: string;
  expires_at: number;
  current_version: number;
  snapshot_json: string;
}

interface HistoricalVersionRow {
  snapshot_json: string;
  snapshot_sha256: string;
  current_version: number;
}

function changes(result: D1Result | undefined): number {
  return result?.meta.changes ?? -1;
}

function batchSucceeded(results: D1Result[]): boolean {
  return results.every((result) => result.success);
}

function toCurrentPersona(row: CurrentPersonaRow): CurrentPersona {
  return {
    ownerId: row.owner_id,
    version: row.current_version,
    snapshot: parsePersonaSnapshot(row.snapshot_json),
    snapshotHash: row.snapshot_sha256,
    changeSummary: row.change_summary,
    enabled: row.enabled === 1,
    consentStatus: row.consent_status,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 500,
    )
  ) {
    throw new Error("persona_patch_value_invalid");
  }
  return [...value];
}

function normalizePatch(patch: PersonaPatchInput[]): NormalizedPersonaPatch[] {
  if (patch.length === 0 || patch.length > 32) {
    throw new Error("persona_patch_value_invalid");
  }

  const normalized = patch.map((operation) => {
    if (!ALLOWED_PATCH_PATHS.has(operation.path)) {
      throw new Error("persona_patch_path_not_allowed");
    }
    return {
      path: operation.path as AllowedPatchPath,
      value:
        operation.path === "comfort.opening"
          ? normalizeScalarString(operation.value)
          : normalizeStringArray(operation.value),
    };
  });
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_PATCH_BYTES) {
    throw new Error("persona_patch_too_large");
  }
  return normalized;
}

function normalizeScalarString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error("persona_patch_value_invalid");
  }
  return value;
}

function parseStoredPatch(json: string): NormalizedPersonaPatch[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("persona_patch_value_invalid");

  const input: PersonaPatchInput[] = parsed.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("persona_patch_value_invalid");
    }
    const record: Record<string, unknown> = entry;
    return {
      path: typeof record.path === "string" ? record.path : "",
      value: record.value,
    };
  });
  return normalizePatch(input);
}

function applyPatch(
  source: PersonaSnapshot,
  patch: NormalizedPersonaPatch[],
): PersonaSnapshot {
  const snapshot = parsePersonaSnapshot(canonicalPersonaJson(source));
  const asArray = (value: string | string[]): string[] => {
    if (!Array.isArray(value)) throw new Error("persona_patch_value_invalid");
    return value;
  };

  for (const operation of patch) {
    const value = Array.isArray(operation.value)
      ? [...operation.value]
      : operation.value;
    switch (operation.path) {
      case "relationship.confidenceFacts":
        snapshot.relationship.confidenceFacts = asArray(value);
        break;
      case "relationship.rules":
        snapshot.relationship.rules = asArray(value);
        break;
      case "relationship.meetingRules":
        snapshot.relationship.meetingRules = asArray(value);
        break;
      case "coreTraits.labels":
        snapshot.coreTraits.labels = asArray(value);
        break;
      case "coreTraits.rules":
        snapshot.coreTraits.rules = asArray(value);
        break;
      case "expression.markers":
        snapshot.expression.markers = asArray(value);
        break;
      case "expression.phraseEndings":
        snapshot.expression.phraseEndings = asArray(value);
        break;
      case "expression.rules":
        snapshot.expression.rules = asArray(value);
        break;
      case "expression.prohibited":
        snapshot.expression.prohibited = asArray(value);
        break;
      case "comfort.opening":
        if (typeof value !== "string") throw new Error("persona_patch_value_invalid");
        snapshot.comfort.opening = value;
        break;
      case "comfort.sequence":
        snapshot.comfort.sequence = asArray(value);
        break;
      case "comfort.rules":
        snapshot.comfort.rules = asArray(value);
        break;
      case "advice.rules":
        snapshot.advice.rules = asArray(value);
        break;
      case "viewOfOwner.rules":
        snapshot.viewOfOwner.rules = asArray(value);
        break;
      case "interests.topics":
        snapshot.interests.topics = asArray(value);
        break;
      case "interests.publicFigures":
        snapshot.interests.publicFigures = asArray(value);
        break;
      case "interests.rules":
        snapshot.interests.rules = asArray(value);
        break;
      case "uncertainty.unknowns":
        snapshot.uncertainty.unknowns = asArray(value);
        break;
      case "uncertainty.prohibitedInferences":
        snapshot.uncertainty.prohibitedInferences = asArray(value);
        break;
      case "intimacy.rules":
        snapshot.intimacy.rules = asArray(value);
        break;
      case "intimacy.prohibitedTerms":
        snapshot.intimacy.prohibitedTerms = asArray(value);
        break;
      case "rhythm.rules":
        snapshot.rhythm.rules = asArray(value);
        break;
      case "proactive.rules":
        snapshot.proactive.rules = asArray(value);
        break;
      case "knowledge.rules":
        snapshot.knowledge.rules = asArray(value);
        break;
    }
  }

  return snapshot;
}

export async function getCurrentPersona(
  db: D1Database,
  ownerId: number,
): Promise<CurrentPersona | null> {
  const row = await db
    .prepare(
      `SELECT persona_profiles.owner_id, persona_profiles.current_version,
              persona_profiles.enabled, persona_profiles.consent_status,
              persona_versions.snapshot_json,
              persona_versions.snapshot_sha256,
              persona_versions.change_summary
       FROM persona_profiles
       JOIN persona_versions
         ON persona_versions.owner_id = persona_profiles.owner_id
        AND persona_versions.version = persona_profiles.current_version
       WHERE persona_profiles.owner_id = ?`,
    )
    .bind(ownerId)
    .first<CurrentPersonaRow>();

  return row === null ? null : toCurrentPersona(row);
}

export async function seedPersona(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<CurrentPersona> {
  const existing = await getCurrentPersona(db, ownerId);
  if (existing !== null) return existing;

  const snapshotJson = canonicalPersonaJson(PERSONA_V1);
  const snapshotHash = await sha256Hex(snapshotJson);
  const summary = "获批的 Persona Bot 初始人格";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO persona_profiles (
           owner_id, current_version, enabled, consent_status, created_at, updated_at
         ) VALUES (?, 1, 1, 'confirmed', ?, ?)`,
      )
      .bind(ownerId, now, now),
    db
      .prepare(
        `INSERT INTO persona_versions (
           owner_id, version, snapshot_json, snapshot_sha256,
           change_summary, created_at
         ) VALUES (?, 1, ?, ?, ?, ?)`,
      )
      .bind(ownerId, snapshotJson, snapshotHash, summary, now),
    db
      .prepare(
        `INSERT INTO persona_version_events (
           owner_id, event_type, from_version, to_version, summary, created_at
         ) VALUES (?, 'create', NULL, 1, ?, ?)`,
      )
      .bind(ownerId, summary, now),
  ]);
  if (!batchSucceeded(results) || results.some((result) => changes(result) !== 1)) {
    throw new Error("persona_seed_failed");
  }

  const created = await getCurrentPersona(db, ownerId);
  if (created === null) throw new Error("persona_seed_missing");
  return created;
}

export async function createPersonaDraft(
  db: D1Database,
  input: CreatePersonaDraftInput,
): Promise<PersonaDraftReference> {
  if (
    input.summary.length === 0 ||
    input.summary.length > 500 ||
    input.impactScope.length === 0 ||
    input.impactScope.length > 200
  ) {
    throw new Error("persona_draft_metadata_invalid");
  }
  if ((await getCurrentPersona(db, input.ownerId)) === null) {
    throw new Error("persona_profile_not_found");
  }

  const normalized = normalizePatch(input.patch);
  const draftId = randomId();
  const expiresAt = input.now + DRAFT_LIFETIME_SECONDS;
  await db
    .prepare(
      `INSERT INTO persona_change_drafts (
         id, owner_id, operation, summary, impact_scope, patch_json,
         source_message_id, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      draftId,
      input.ownerId,
      input.operation,
      input.summary,
      input.impactScope,
      JSON.stringify(normalized),
      input.sourceMessageId ?? null,
      expiresAt,
      input.now,
    )
    .run();

  return { draftId, expiresAt };
}

export async function confirmPersonaDraft(
  db: D1Database,
  ownerId: number,
  draftId: string,
  now: number,
): Promise<PersonaMutationResult> {
  const draft = await db
    .prepare(
      `SELECT persona_change_drafts.operation, persona_change_drafts.summary,
              persona_change_drafts.patch_json,
              persona_change_drafts.expires_at,
              persona_profiles.current_version,
              persona_versions.snapshot_json
       FROM persona_change_drafts
       JOIN persona_profiles
         ON persona_profiles.owner_id = persona_change_drafts.owner_id
       JOIN persona_versions
         ON persona_versions.owner_id = persona_profiles.owner_id
        AND persona_versions.version = persona_profiles.current_version
       WHERE persona_change_drafts.id = ?
         AND persona_change_drafts.owner_id = ?
         AND persona_change_drafts.expires_at >= ?`,
    )
    .bind(draftId, ownerId, now)
    .first<DraftRow>();
  if (draft === null) return { ok: false, reason: "not_found_or_expired" };

  const snapshot = applyPatch(
    parsePersonaSnapshot(draft.snapshot_json),
    parseStoredPatch(draft.patch_json),
  );
  const snapshotJson = canonicalPersonaJson(snapshot);
  const snapshotHash = await sha256Hex(snapshotJson);
  const nextVersion = draft.current_version + 1;
  const gate = `EXISTS (
    SELECT 1 FROM persona_profiles
    WHERE owner_id = ? AND current_version = ?
  )`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO persona_versions (
           owner_id, version, snapshot_json, snapshot_sha256,
           change_summary, created_at
         ) SELECT ?, ?, ?, ?, ?, ? WHERE ${gate}`,
      )
      .bind(
        ownerId,
        nextVersion,
        snapshotJson,
        snapshotHash,
        draft.summary,
        now,
        ownerId,
        draft.current_version,
      ),
    db
      .prepare(
        `INSERT INTO persona_version_events (
           owner_id, event_type, from_version, to_version, summary, created_at
         ) SELECT ?, ?, ?, ?, ?, ? WHERE ${gate}`,
      )
      .bind(
        ownerId,
        draft.operation,
        draft.current_version,
        nextVersion,
        draft.summary,
        now,
        ownerId,
        draft.current_version,
      ),
    db
      .prepare(
        `DELETE FROM persona_change_drafts
         WHERE id = ? AND owner_id = ? AND expires_at >= ? AND ${gate}`,
      )
      .bind(
        draftId,
        ownerId,
        now,
        ownerId,
        draft.current_version,
      ),
    db
      .prepare(
        `UPDATE persona_profiles
         SET current_version = ?, updated_at = ?
         WHERE owner_id = ? AND current_version = ?`,
      )
      .bind(nextVersion, now, ownerId, draft.current_version),
  ]);
  if (!batchSucceeded(results) || results.some((result) => changes(result) !== 1)) {
    return { ok: false, reason: "version_conflict" };
  }

  const persona = await getCurrentPersona(db, ownerId);
  if (persona === null) throw new Error("persona_version_missing");
  return { ok: true, persona };
}

export async function rollbackPersona(
  db: D1Database,
  ownerId: number,
  targetVersion: number,
  summary: string,
  now: number,
): Promise<PersonaMutationResult> {
  const historical = await db
    .prepare(
      `SELECT target.snapshot_json, target.snapshot_sha256,
              persona_profiles.current_version
       FROM persona_versions AS target
       JOIN persona_profiles ON persona_profiles.owner_id = target.owner_id
       WHERE target.owner_id = ? AND target.version = ?`,
    )
    .bind(ownerId, targetVersion)
    .first<HistoricalVersionRow>();
  if (historical === null) return { ok: false, reason: "not_found_or_expired" };

  parsePersonaSnapshot(historical.snapshot_json);
  const nextVersion = historical.current_version + 1;
  const gate = `EXISTS (
    SELECT 1 FROM persona_profiles
    WHERE owner_id = ? AND current_version = ?
  )`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO persona_versions (
           owner_id, version, snapshot_json, snapshot_sha256,
           change_summary, created_at
         ) SELECT ?, ?, ?, ?, ?, ? WHERE ${gate}`,
      )
      .bind(
        ownerId,
        nextVersion,
        historical.snapshot_json,
        historical.snapshot_sha256,
        summary,
        now,
        ownerId,
        historical.current_version,
      ),
    db
      .prepare(
        `INSERT INTO persona_version_events (
           owner_id, event_type, from_version, to_version, summary, created_at
         ) SELECT ?, 'rollback', ?, ?, ?, ? WHERE ${gate}`,
      )
      .bind(
        ownerId,
        historical.current_version,
        nextVersion,
        summary,
        now,
        ownerId,
        historical.current_version,
      ),
    db
      .prepare(
        `UPDATE persona_profiles
         SET current_version = ?, updated_at = ?
         WHERE owner_id = ? AND current_version = ?`,
      )
      .bind(nextVersion, now, ownerId, historical.current_version),
  ]);
  if (!batchSucceeded(results) || results.some((result) => changes(result) !== 1)) {
    return { ok: false, reason: "version_conflict" };
  }

  const persona = await getCurrentPersona(db, ownerId);
  if (persona === null) throw new Error("persona_rollback_missing");
  return { ok: true, persona };
}

export async function deletePersona(
  db: D1Database,
  ownerId: number,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare("DELETE FROM persona_runtime_state WHERE owner_id = ?")
      .bind(ownerId),
    db
      .prepare("DELETE FROM persona_change_drafts WHERE owner_id = ?")
      .bind(ownerId),
    db
      .prepare("DELETE FROM persona_version_events WHERE owner_id = ?")
      .bind(ownerId),
    db
      .prepare("DELETE FROM persona_versions WHERE owner_id = ?")
      .bind(ownerId),
    db.prepare("DELETE FROM persona_profiles WHERE owner_id = ?").bind(ownerId),
  ]);

  return batchSucceeded(results) && changes(results[4]) === 1;
}
