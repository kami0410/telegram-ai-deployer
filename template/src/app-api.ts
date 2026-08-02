import {
  cancelPersonaDraft,
  deleteEpisode,
  deleteMemory,
  getManagementOverview,
  listEpisodes,
  listMemories,
  listReplyMemoryUsage,
  listPersonaDrafts,
  listPersonaVersions,
  recordManagementEvent,
  updateMemory,
} from "./storage/management-repository";
import {
  confirmPersonaDraft,
  getCurrentPersona,
  replacePersonaDraft,
  rollbackPersona,
  type PersonaPatchInput,
} from "./storage/persona-repository";
import {
  clearSessionCookie,
  cookieValue,
  createAppSession,
  sessionCookie,
  verifyAppSession,
} from "./app-session";
import { verifyTelegramInitData } from "./telegram-init-data";
import { getOwner } from "./storage/owner-repository";
import { claimUpdate, markUpdate } from "./storage/update-repository";
import {
  getMemoryConflict,
  updateMemoryConflictCandidate,
} from "./storage/semantic-memory-repository";
import {
  setMemoryControl,
  type MemoryControl,
  type MemoryEntityKind,
} from "./storage/memory-control-repository";
import {
  getChatPreferences,
  updateChatPreferences,
} from "./storage/chat-preferences-repository";
import {
  listRelationshipTimeline,
  updateRelationshipTimelineItem,
} from "./storage/realism-repository";
import {
  getRecallTrace,
  listRecallTraces,
} from "./storage/memory-recall-repository";
import {
  getActiveIdentityCore,
  listIdentityCandidates,
  promoteIdentityCandidate,
  rejectIdentityCandidate,
  revertIdentityCoreEntry,
} from "./storage/identity-core-repository";
import { getProactiveStats } from "./storage/proactive-decision-repository";
import { getQualityEventStats } from "./quality-events";

const MAX_BODY_BYTES = 16 * 1_024;
const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders !== undefined) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(value), { status, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSafeId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, "invalid_resource_id");
  return id;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  if (request.body === null) throw new HttpError(400, "invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

async function authenticate(request: Request, env: Env, now: number): Promise<number> {
  const token = cookieValue(request);
  if (token === null) throw new HttpError(401, "unauthorized");
  const session = await verifyAppSession(token, env.TELEGRAM_BOT_TOKEN, now);
  if (session === null) throw new HttpError(401, "unauthorized");
  const owner = await getOwner(env.DB);
  if (
    owner === null ||
    owner.ownerId !== session.ownerId ||
    owner.telegramUserId !== session.telegramUserId
  ) {
    throw new HttpError(401, "unauthorized");
  }
  return session.ownerId;
}

async function login(request: Request, env: Env, now: number): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.initData !== "string" || body.initData.length === 0) {
    throw new HttpError(400, "invalid_init_data");
  }
  let verified;
  try {
    verified = await verifyTelegramInitData(body.initData, env.TELEGRAM_BOT_TOKEN, now);
  } catch {
    throw new HttpError(401, "invalid_init_data");
  }
  const owner = await getOwner(env.DB);
  if (
    owner === null ||
    owner.telegramUserId !== verified.userId ||
    owner.telegramChatId !== verified.chatId
  ) {
    throw new HttpError(403, "not_bound");
  }
  const token = await createAppSession(
    owner.ownerId,
    verified.userId,
    env.TELEGRAM_BOT_TOKEN,
    now,
  );
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
}

async function audit(
  db: D1Database,
  ownerId: number,
  action: string,
  resourceType: string,
  resourceId: string,
  result: string,
  now: number,
): Promise<void> {
  await recordManagementEvent(db, {
    ownerId, action, resourceType, resourceId, result, now,
  });
}

async function route(
  request: Request,
  env: Env,
  ownerId: number,
  now: number,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/app/overview" && request.method === "GET") {
    return json({
      ...await getManagementOverview(env.DB, ownerId),
      runtime: {
        status: "online",
        model: env.DEEPSEEK_MODEL,
        memory: "D1 + Vectorize",
        checkedAt: now,
      },
    });
  }
  if (path === "/api/app/chat-preferences" && request.method === "GET") {
    return json(await getChatPreferences(env.DB, ownerId));
  }
  if (path === "/api/app/proactive-stats" && request.method === "GET") {
    return json({ items: await getProactiveStats(env.DB, ownerId, now - 7 * 86_400) });
  }
  if (path === "/api/app/quality-stats" && request.method === "GET") {
    return json({ items: await getQualityEventStats(env.DB, ownerId, now - 7 * 86_400) });
  }
  if (path === "/api/app/chat-preferences" && request.method === "PATCH") {
    const body = await readJson(request);
    const nullableInteger = (value: unknown): value is number | null =>
      value === null || Number.isSafeInteger(value);
    if (
      typeof body.proactiveEnabled !== "boolean" ||
      !Number.isSafeInteger(body.dailyMin) ||
      !Number.isSafeInteger(body.dailyMax) ||
      !nullableInteger(body.quietStartMinute) ||
      !nullableInteger(body.quietEndMinute) ||
      !nullableInteger(body.pausedUntil) ||
      (body.pausedUntil !== null && body.pausedUntil < 0) ||
      (body.quietStartMinute === null) !== (body.quietEndMinute === null) ||
      (body.dailyMin as number) < 1 ||
      (body.dailyMax as number) > 3 ||
      (body.dailyMin as number) > (body.dailyMax as number) ||
      (body.quietStartMinute !== null && (body.quietStartMinute < 0 || body.quietStartMinute > 1439)) ||
      (body.quietEndMinute !== null && (body.quietEndMinute < 0 || body.quietEndMinute > 1439))
    ) throw new HttpError(400, "invalid_chat_preferences");
    await updateChatPreferences(env.DB, ownerId, {
      proactiveEnabled: body.proactiveEnabled,
      dailyMin: body.dailyMin as number,
      dailyMax: body.dailyMax as number,
      quietStartMinute: body.quietStartMinute,
      quietEndMinute: body.quietEndMinute,
      pausedUntil: body.pausedUntil,
    }, now);
    await audit(env.DB, ownerId, "update", "chat_preferences", String(ownerId), "ok", now);
    return json(await getChatPreferences(env.DB, ownerId));
  }
  if (path === "/api/app/memories" && request.method === "GET") {
    const query = url.searchParams.get("q");
    const category = url.searchParams.get("category");
    const cursor = url.searchParams.get("cursor");
    return json(await listMemories(env.DB, ownerId, {
      ...(query === null ? {} : { query }),
      ...(category === null ? {} : { category }),
      ...(cursor === null ? {} : { cursor }),
      limit: Number(url.searchParams.get("limit") ?? "20"),
    }));
  }
  if (path === "/api/app/episodes" && request.method === "GET") {
    const category = url.searchParams.get("category");
    return json(await listEpisodes(env.DB, ownerId, category === null ? undefined : category));
  }
  if (path === "/api/app/reply-memory-usage" && request.method === "GET") {
    return json({ items: await listReplyMemoryUsage(env.DB, ownerId, 20) });
  }
  if (path === "/api/app/memory-recalls" && request.method === "GET") {
    return json({ items: await listRecallTraces(env.DB, ownerId, 20) });
  }
  const recallMatch = path.match(/^\/api\/app\/memory-recalls\/(\d+)$/u);
  if (recallMatch !== null && request.method === "GET") {
    const item = await getRecallTrace(env.DB, ownerId, asSafeId(recallMatch[1] ?? ""));
    return item === null ? json({ error: "not_found" }, 404) : json(item);
  }
  if (path === "/api/app/relationship-timeline" && request.method === "GET") {
    return json({ items: await listRelationshipTimeline(env.DB, ownerId) });
  }
  const timelineMatch = path.match(/^\/api\/app\/relationship-timeline\/(\d+)$/u);
  if (timelineMatch !== null && request.method === "PATCH") {
    const id = asSafeId(timelineMatch[1] ?? "");
    const body = await readJson(request);
    if (body.value !== undefined && typeof body.value !== "string") throw new HttpError(400, "invalid_timeline_value");
    if (body.control !== undefined && body.control !== "normal" && body.control !== "pinned" && body.control !== "ignored") {
      throw new HttpError(400, "invalid_timeline_control");
    }
    const updated = await updateRelationshipTimelineItem(env.DB, ownerId, id, {
      ...(typeof body.value === "string" ? { value: body.value } : {}),
      ...(body.control === "normal" || body.control === "pinned" || body.control === "ignored"
        ? { control: body.control } : {}),
      now,
    });
    await audit(env.DB, ownerId, "update", "relationship_timeline", String(id), updated ? "ok" : "not_found", now);
    return updated ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }
  const controlMatch = path.match(/^\/api\/app\/memory-controls\/(fact|episode)\/(\d+)$/u);
  if (controlMatch !== null && request.method === "PATCH") {
    const kind = controlMatch[1] as MemoryEntityKind;
    const entityId = asSafeId(controlMatch[2] ?? "");
    const body = await readJson(request);
    if (body.control !== "normal" && body.control !== "pinned" && body.control !== "ignored") {
      throw new HttpError(400, "invalid_memory_control");
    }
    const updated = await setMemoryControl(
      env.DB,
      ownerId,
      kind,
      entityId,
      body.control as MemoryControl,
      now,
    );
    await audit(env.DB, ownerId, "update", "memory_control", `${kind}:${entityId}`, updated ? String(body.control) : "not_found", now);
    return updated ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }
  const memoryMatch = path.match(/^\/api\/app\/memories\/(\d+)$/u);
  if (memoryMatch !== null && request.method === "PATCH") {
    const memoryId = asSafeId(memoryMatch[1] ?? "");
    const body = await readJson(request);
    if (
      typeof body.category !== "string" ||
      typeof body.factValue !== "string" ||
      typeof body.confidence !== "string" ||
      !Number.isSafeInteger(body.expectedUpdatedAt)
    ) throw new HttpError(400, "invalid_memory");
    const result = await updateMemory(env.DB, ownerId, memoryId, {
      category: body.category,
      factValue: body.factValue,
      confidence: body.confidence,
      expectedUpdatedAt: body.expectedUpdatedAt as number,
      now,
    });
    await audit(env.DB, ownerId, "update", "memory", String(memoryId), result.ok ? "ok" : "conflict", now);
    return result.ok ? json(result) : json({ error: "version_conflict" }, 409);
  }
  if (memoryMatch !== null && request.method === "DELETE") {
    const memoryId = asSafeId(memoryMatch[1] ?? "");
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw new HttpError(400, "invalid_memory");
    const deleted = await deleteMemory(
      env.DB,
      ownerId,
      memoryId,
      body.expectedUpdatedAt as number,
      now,
    );
    await audit(env.DB, ownerId, "delete", "memory", String(memoryId), deleted ? "ok" : "conflict", now);
    return deleted ? json({ ok: true }) : json({ error: "version_conflict" }, 409);
  }
  const episodeMatch = path.match(/^\/api\/app\/episodes\/(\d+)$/u);
  if (episodeMatch !== null && request.method === "DELETE") {
    const episodeId = asSafeId(episodeMatch[1] ?? "");
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw new HttpError(400, "invalid_episode");
    const deleted = await deleteEpisode(
      env.DB,
      ownerId,
      episodeId,
      body.expectedUpdatedAt as number,
      now,
    );
    await audit(env.DB, ownerId, "delete", "episode", String(episodeId), deleted ? "ok" : "conflict", now);
    return deleted ? json({ ok: true }) : json({ error: "version_conflict" }, 409);
  }
  const conflictMatch = path.match(/^\/api\/app\/memory-conflicts\/([0-9a-f-]{36})$/u);
  if (conflictMatch !== null) {
    const conflictId = conflictMatch[1] ?? "";
    if (request.method === "GET") {
      const conflict = await getMemoryConflict(env.DB, ownerId, conflictId, now);
      return conflict === null ? json({ error: "not_found" }, 404) : json(conflict);
    }
    if (request.method === "PATCH") {
      const body = await readJson(request);
      if (
        typeof body.category !== "string" ||
        typeof body.factValue !== "string" ||
        typeof body.confidence !== "string"
      ) throw new HttpError(400, "invalid_memory_conflict");
      const updated = await updateMemoryConflictCandidate(env.DB, ownerId, conflictId, {
        category: body.category,
        factValue: body.factValue,
        confidence: body.confidence,
        now,
      });
      await audit(
        env.DB,
        ownerId,
        "update",
        "memory_conflict",
        conflictId,
        updated ? "ok" : "not_found",
        now,
      );
      return updated ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }
  }
  if (path === "/api/app/persona" && request.method === "GET") {
    return json({
      current: await getCurrentPersona(env.DB, ownerId),
      versions: await listPersonaVersions(env.DB, ownerId),
    });
  }
  if (path === "/api/app/identity-core" && request.method === "GET") {
    const [entries, candidates] = await Promise.all([
      getActiveIdentityCore(env.DB, ownerId), listIdentityCandidates(env.DB, ownerId),
    ]);
    return json({ entries, candidates });
  }
  const identityMatch = path.match(/^\/api\/app\/identity-core\/(\d+)\/(confirm|reject|revert)$/u);
  if (identityMatch !== null && request.method === "POST") {
    const id = asSafeId(identityMatch[1] ?? ""); const action = identityMatch[2];
    const changed = action === "confirm"
      ? await promoteIdentityCandidate(env.DB, ownerId, id, now)
      : action === "reject"
        ? await rejectIdentityCandidate(env.DB, ownerId, id, now)
        : await revertIdentityCoreEntry(env.DB, ownerId, id, now);
    await audit(env.DB, ownerId, action ?? "update", "identity_core", String(id), changed ? "ok" : "not_found", now);
    return changed ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }
  if (path === "/api/app/persona/rollback" && request.method === "POST") {
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.targetVersion) || (body.targetVersion as number) < 1) {
      throw new HttpError(400, "invalid_persona_version");
    }
    const target = body.targetVersion as number;
    const result = await rollbackPersona(env.DB, ownerId, target, `面板回滚到 v${target}`, now);
    await audit(env.DB, ownerId, "rollback", "persona", String(target), result.ok ? "ok" : result.reason, now);
    return result.ok ? json(result) : json({ error: result.reason }, result.reason === "version_conflict" ? 409 : 404);
  }
  if (path === "/api/app/drafts" && request.method === "GET") {
    return json({ items: await listPersonaDrafts(env.DB, ownerId, now) });
  }
  const draftMatch = path.match(/^\/api\/app\/drafts\/([A-Za-z0-9_-]+)(?:\/(confirm|cancel|regenerate))?$/u);
  if (draftMatch !== null) {
    const draftId = draftMatch[1] ?? "";
    const action = draftMatch[2];
    if (request.method === "POST" && action === "confirm") {
      const result = await confirmPersonaDraft(env.DB, ownerId, draftId, now);
      await audit(env.DB, ownerId, "confirm", "draft", draftId, result.ok ? "ok" : result.reason, now);
      return result.ok ? json(result) : json({ error: result.reason }, result.reason === "version_conflict" ? 409 : 404);
    }
    if (request.method === "POST" && action === "cancel") {
      const cancelled = await cancelPersonaDraft(env.DB, ownerId, draftId);
      await audit(env.DB, ownerId, "cancel", "draft", draftId, cancelled ? "ok" : "not_found", now);
      return cancelled ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }
    if (request.method === "POST" && action === "regenerate") {
      const source = await env.DB.prepare(
        `SELECT persona_change_drafts.operation,
                persona_change_drafts.source_message_id,
                messages.telegram_update_id
         FROM persona_change_drafts
         JOIN messages ON messages.id = persona_change_drafts.source_message_id
         WHERE persona_change_drafts.id = ? AND persona_change_drafts.owner_id = ?
           AND persona_change_drafts.expires_at >= ?`,
      ).bind(draftId, ownerId, now).first<{
        operation: "correction" | "addition";
        source_message_id: number;
        telegram_update_id: number;
      }>();
      if (source === null) return json({ error: "not_found" }, 404);
      const randomPart = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
      const trackingId = -(now * 1_000 + (randomPart % 1_000));
      const claimed = await claimUpdate(env.DB, trackingId, ownerId, now);
      if (claimed !== "new") return json({ error: "temporary_conflict" }, 409);
      try {
        await env.MESSAGE_QUEUE.send({
          type: "persona_draft",
          operation: source.operation,
          ownerId,
          telegramUpdateId: trackingId,
          messageId: source.source_message_id,
          sourceTelegramUpdateId: source.telegram_update_id,
          replaceDraftId: draftId,
        });
        await markUpdate(env.DB, trackingId, "queued", now);
      } catch {
        await markUpdate(env.DB, trackingId, "failed", now, "queue_send_failed");
        throw new HttpError(503, "temporary_failure");
      }
      await audit(env.DB, ownerId, "regenerate", "draft", draftId, "queued", now);
      return json({ ok: true, status: "queued" }, 202);
    }
    if (request.method === "PATCH" && action === undefined) {
      const body = await readJson(request);
      if (
        typeof body.summary !== "string" ||
        typeof body.impactScope !== "string" ||
        !Array.isArray(body.patch)
      ) throw new HttpError(400, "invalid_draft");
      const result = await replacePersonaDraft(env.DB, ownerId, draftId, {
        summary: body.summary,
        impactScope: body.impactScope,
        patch: body.patch as PersonaPatchInput[],
        now,
      });
      await audit(env.DB, ownerId, "replace", "draft", draftId, result === null ? "not_found" : "ok", now);
      return result === null ? json({ error: "not_found" }, 404) : json(result);
    }
  }
  if (path === "/api/app/export" && request.method === "GET") {
    const [memories, episodes] = await Promise.all([env.DB.prepare(
      `SELECT category, fact_key, fact_value, confidence, created_at, updated_at
       FROM memory_facts WHERE owner_id = ? ORDER BY updated_at DESC, id DESC`,
    ).bind(ownerId).all(), env.DB.prepare(
      `SELECT category, content, people_json, topics_json, occurred_at,
              auto_inject_until, created_at, updated_at
       FROM memory_episodes
       WHERE owner_id = ? AND status = 'active'
       ORDER BY occurred_at DESC, id DESC`,
    ).bind(ownerId).all()]);
    const payload = {
      exportedAt: new Date(now * 1_000).toISOString(),
      persona: await getCurrentPersona(env.DB, ownerId),
      personaVersions: (await listPersonaVersions(env.DB, ownerId, 100)).map(({ snapshot: _snapshot, ...metadata }) => metadata),
      memoryFacts: memories.results,
      memoryEpisodes: episodes.results,
    };
    return json(payload, 200, {
      "content-disposition": `attachment; filename="persona-export-${new Date(now * 1_000).toISOString().slice(0, 10)}.json"`,
    });
  }
  throw new HttpError(404, "not_found");
}

export async function handleAppApi(
  request: Request,
  env: Env,
  now = Math.floor(Date.now() / 1_000),
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (path === "/api/app/login" && request.method === "POST") {
      return await login(request, env, now);
    }
    if (path === "/api/app/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
    }
    const ownerId = await authenticate(request, env, now);
    if (path === "/api/app/session" && request.method === "GET") {
      return json({ ok: true });
    }
    return await route(request, env, ownerId, now);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code }, error.status);
    const code = error instanceof Error ? error.message : "internal_error";
    if (code.startsWith("memory_") || code.startsWith("persona_")) {
      return json({ error: "invalid_request" }, 400);
    }
    return json({ error: "internal_error" }, 500);
  }
}
