import {
  DeepSeekError,
  materializePersonaPatch,
  requestChat,
  requestMemoryUpdate,
  requestPersonaDraft,
  type DeepSeekOptions,
} from "./deepseek";
import { isPersonaCorrectionText } from "./commands";
import { buildAskPrompt, buildPersonaPrompt } from "./prompt";
import { classifyDialogue } from "./dialogue-guidance";
import { sanitizePersonaReply } from "./persona-reply";
import {
  calculateBubbleGapSeconds,
  nextBubbleDelaySeconds,
  proactiveOutputTokenBudget,
  replyOutputTokenBudget,
  splitSemanticBubbles,
  type DeliveryFlow,
} from "./reply-delivery";
import { createTelegramClient, TelegramError } from "./telegram";
import { describeImage, type VisionAi } from "./image-vision";
import {
  appendMessage,
  countUnsummarizedPersonaMessages,
  getLatestConversationSummary,
  getOrCreateActiveConversation,
  getRecentMessages,
  getPersonaMessagesAfter,
  saveConversationSummary,
} from "./storage/chat-repository";
import {
  allBubblesSent,
  createDeliveryPlan,
  getDeliveriesForAssistant,
  getDelivery,
  markDeliveryFailed,
  markDeliverySending,
  markDeliverySent,
  type DeliveryRecord,
} from "./storage/delivery-repository";
import {
  getRelevantMemoryFacts,
} from "./storage/memory-repository";
import { saveMemoryExtraction } from "./storage/semantic-memory-repository";
import {
  getGraphCandidates,
  upsertMemoryGraph,
} from "./storage/memory-graph-repository";
import {
  rankMemoryCandidates,
  type MemoryRetrievalCandidate,
  type RankedMemoryCandidate,
} from "./memory-reranker";
import { saveRecallTrace } from "./storage/memory-recall-repository";
import { getActiveIdentityCore, recordIdentityEvidence } from "./storage/identity-core-repository";
import { detectRepairSignal } from "./interaction-repair";
import { recordQualityEvent } from "./quality-events";
import {
  attachProactiveOutcome,
  markProactiveSent,
} from "./storage/proactive-decision-repository";
import {
  clearMemoryUpdateFailure,
  recordMemoryUpdateFailure,
} from "./storage/memory-update-failure-repository";
import {
  claimVectorSyncJob,
} from "./storage/semantic-memory-repository";
import {
  getSemanticRelevantMemories,
  syncVectorJob,
  type EmbeddingAi,
  type MemoryVectorIndex,
} from "./semantic-memory";
import { getOwner } from "./storage/owner-repository";
import {
  createPersonaDraft,
  getCurrentPersona,
} from "./storage/persona-repository";
import {
  clearBusyIfDue,
  getRuntimeState,
  setBusyUntil,
} from "./storage/runtime-repository";
import {
  getActiveRelationshipStates,
  getEligibleOpenThreadFollowUp,
  markOpenThreadFollowedUp,
  saveRelationshipStates,
} from "./storage/relationship-repository";
import {
  canShowAutomaticAdjustment,
  getConfirmedInteractionPreferences,
  getRecentReplyFeedback,
  isAdjustmentCandidate,
  isLastBubbleDelivery,
  markAdjustmentShown,
  recordReplyContext,
} from "./storage/reply-feedback-repository";
import {
  isProactiveAllowedNow,
  noteProactiveSent,
  noteUserReply,
} from "./storage/chat-preferences-repository";
import {
  getRelevantTimeMemories,
  getTimeMemoryUpdateContext,
  saveTimeMemories,
} from "./storage/time-memory-repository";
import {
  getConversationSignals,
  getRecentEvidenceReflections,
  saveEvidenceReflection,
} from "./storage/realism-repository";
import {
  addDailyTokenUsage,
  reserveDailyRequest,
} from "./storage/usage-repository";
import { markUpdate } from "./storage/update-repository";
import { safeLog } from "./logging";
import { sha256Hex } from "./security";
import {
  claimReminderDelivery,
  markReminderSent,
  releaseReminderClaim,
} from "./storage/reminder-repository";

export const BUSY_MESSAGE = "我先去忙啦";
const DAILY_LIMIT_MESSAGE = "今天先聊到这里吧，明天再继续呀。";
const SAFE_PROACTIVE_SHARES = [
  "最近有没有吃到喜欢的水果或小甜品",
  "可以聊聊最近在看的韩剧或喜欢的韩星",
  "可以分享一个不涉及个人经历的轻松学习或生活观点",
  "可以提醒休息、吃饭或别给自己太大压力",
] as const;

export type MessageFlow = DeliveryFlow;

export {
  calculateBubbleGapSeconds,
  proactiveOutputTokenBudget,
  replyOutputTokenBudget,
  splitSemanticBubbles,
};

export type QueueJob =
  | {
      type: "chat";
      mode: "persona" | "ask";
      ownerId: number;
      telegramUpdateId: number;
      messageId: number;
      imageKey?: string;
    }
  | { type: "typing"; deliveryId: number }
  | { type: "bubble"; deliveryId: number }
  | { type: "memory_update"; ownerId: number; conversationId: number }
  | { type: "memory_vector_sync"; ownerId: number }
  | { type: "reminder_delivery"; reminderId: string; ownerId: number }
  | { type: "weekly_review"; ownerId: number; weekKey: string }
  | {
      type: "persona_draft";
      operation: "correction" | "addition";
      ownerId: number;
      telegramUpdateId: number;
      messageId: number;
      sourceTelegramUpdateId?: number;
      replaceDraftId?: string;
    }
  | { type: "busy_resume"; ownerId: number }
  | { type: "proactive"; ownerId: number; scheduledAt: number }
  | {
      type: "ephemeral";
      mode: "temp" | "redo";
      ownerId: number;
      telegramUpdateId: number;
      chatId: number;
      content: string;
    };

export interface RandomSource {
  nextUint32(): number;
}

export interface QueueSender {
  send(job: QueueJob, options?: { delaySeconds?: number }): Promise<void>;
}

export interface QueueDependencies {
  fetcher?: typeof fetch;
  queue?: QueueSender;
  now?: () => number;
  random?: RandomSource;
  busyProbabilityPercent?: number;
  dailyMessageLimit?: number;
  semanticMemory?: { ai: EmbeddingAi; index: MemoryVectorIndex };
  vision?: (base64: string) => Promise<string>;
}

interface SourceMessageRow {
  id: number;
  owner_id: number;
  conversation_id: number;
  content: string;
  mode: "persona" | "ask" | "system";
  telegram_update_id: number;
}

interface PendingBusyRow extends SourceMessageRow {
  status: string;
}

interface AssistantRow {
  id: number;
  conversation_id: number;
  content: string;
}

export class QueueProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`queue_${code}`);
    this.name = "QueueProcessingError";
  }
}

const cryptoRandom: RandomSource = {
  nextUint32() {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  },
};

function semanticServices(
  env: Env,
  dependencies: QueueDependencies,
): { ai: EmbeddingAi; index: MemoryVectorIndex } | null {
  if (dependencies.semanticMemory !== undefined) return dependencies.semanticMemory;
  const bound = env as Env & { AI?: EmbeddingAi; MEMORY_INDEX?: MemoryVectorIndex };
  return bound.AI !== undefined && bound.MEMORY_INDEX !== undefined
    ? { ai: bound.AI, index: bound.MEMORY_INDEX }
    : null;
}

function explicitlyRequestsHistory(text: string): boolean {
  return /(?:上次|以前|之前|过去|还记得|记不记得|当时|去年|前年|昨天|前天)/u.test(text);
}

function mergeMemories(
  primary: Awaited<ReturnType<typeof getRelevantMemoryFacts>>,
  semantic: Awaited<ReturnType<typeof getSemanticRelevantMemories>>,
  limit: number,
): Awaited<ReturnType<typeof getRelevantMemoryFacts>> {
  const unique = new Map<string, (typeof primary)[number]>();
  for (const memory of [...semantic, ...primary]) {
    const key = `${memory.category}\u0000${memory.factKey}\u0000${memory.factValue}`;
    const existing = unique.get(key);
    if (existing === undefined || memory.priorityScore > existing.priorityScore) {
      unique.set(key, memory);
    }
  }
  return [...unique.values()]
    .sort((left, right) => right.priorityScore - left.priorityScore)
    .slice(0, limit);
}

function retrievalCandidate(
  memory: Awaited<ReturnType<typeof getRelevantMemoryFacts>>[number],
  now: number,
): MemoryRetrievalCandidate | null {
  if (memory.sourceKind === undefined || memory.sourceId === undefined) return null;
  return {
    entityKind: memory.sourceKind,
    entityId: memory.sourceId,
    factKey: memory.factKey,
    factValue: memory.factValue,
    category: memory.category,
    confidence: memory.confidence,
    channel: memory.retrievalChannel ?? "lexical",
    relevanceScore: memory.priorityScore,
    updatedAt: memory.updatedAt ?? now,
    ...(memory.sourceMessageId === undefined ? {} : { sourceMessageId: memory.sourceMessageId }),
    status: "active",
    control: memory.control ?? "normal",
  };
}

function promptMemory(candidate: RankedMemoryCandidate) {
  return {
    ...(candidate.entityKind === "graph" ? {} : {
      sourceKind: candidate.entityKind,
      sourceId: candidate.entityId,
    }),
    factKey: candidate.factKey,
    factValue: candidate.factValue,
    category: candidate.category,
    confidence: candidate.confidence,
    priorityScore: candidate.totalScore,
    retrievalChannel: candidate.channel,
    updatedAt: candidate.updatedAt,
    ...(candidate.sourceMessageId === undefined ? {} : { sourceMessageId: candidate.sourceMessageId }),
    control: candidate.control,
  };
}

function randomInteger(
  minimum: number,
  maximum: number,
  random: RandomSource,
): number {
  const width = maximum - minimum + 1;
  return minimum + Math.floor((random.nextUint32() / 0x1_0000_0000) * width);
}

export function classifyMessageFlow(text: string): MessageFlow {
  const intent = classifyDialogue(text).intent;
  if (intent === "safety") return "safety";
  if (intent === "anxiety" || intent === "listen") return "comfort";
  if (intent === "conflict") return "conflict";
  return "normal";
}

export function calculateInitialDelaySeconds(
  flow: MessageFlow,
  random: RandomSource,
): number {
  if (flow === "safety") return 0;
  if (flow === "comfort" || flow === "conflict") {
    return randomInteger(20, 60, random);
  }
  return randomInteger(6, 20, random);
}

export function calculateBusyDurationSeconds(random: RandomSource): number {
  return randomInteger(3_600, 10_800, random);
}

export function shouldEnterBusy(
  flow: MessageFlow,
  random: RandomSource,
  probabilityPercent: number,
): boolean {
  if (flow !== "normal" || probabilityPercent <= 0) return false;
  const bounded = Math.min(100, Math.floor(probabilityPercent));
  return randomInteger(1, 100, random) <= bounded;
}

function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString().slice(0, 10);
}

function beijingTime(epochSeconds: number): string {
  const shifted = new Date((epochSeconds + 8 * 60 * 60) * 1_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  return `${shifted}（北京时间，UTC+8）`;
}

function deepSeekOptions(
  env: Env,
  dependencies: QueueDependencies,
  maxOutputTokens = Number(env.MAX_OUTPUT_TOKENS),
): DeepSeekOptions {
  return {
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL,
    maxOutputTokens,
    ...(dependencies.fetcher === undefined
      ? {}
      : { fetcher: dependencies.fetcher }),
  };
}

function structuredDeepSeekOptions(
  env: Env,
  dependencies: QueueDependencies,
): DeepSeekOptions {
  const options = deepSeekOptions(env, dependencies);
  return { ...options, maxOutputTokens: Math.max(options.maxOutputTokens, 1_200) };
}

function thinkingDeepSeekOptions(
  env: Env,
  dependencies: QueueDependencies,
): DeepSeekOptions {
  return { ...deepSeekOptions(env, dependencies), thinking: "enabled" };
}

function queueSender(env: Env, dependencies: QueueDependencies): QueueSender {
  if (dependencies.queue !== undefined) return dependencies.queue;
  return {
    async send(job, options) {
      await env.MESSAGE_QUEUE.send(job, options);
    },
  };
}

async function loadSourceMessage(
  db: D1Database,
  job: {
    messageId: number;
    ownerId: number;
    telegramUpdateId: number;
    sourceTelegramUpdateId?: number;
  },
): Promise<SourceMessageRow | null> {
  return db
    .prepare(
      `SELECT id, owner_id, conversation_id, content, mode, telegram_update_id
       FROM messages
       WHERE id = ? AND owner_id = ? AND telegram_update_id = ? AND role = 'user'`,
    )
    .bind(
      job.messageId,
      job.ownerId,
      job.sourceTelegramUpdateId ?? job.telegramUpdateId,
    )
    .first<SourceMessageRow>();
}

async function existingAssistant(
  db: D1Database,
  updateIds: number[],
): Promise<AssistantRow | null> {
  if (updateIds.length === 0) return null;
  const placeholders = updateIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT messages.id, messages.conversation_id, messages.content
       FROM processed_updates
       JOIN messages ON messages.id = processed_updates.assistant_message_id
       WHERE processed_updates.telegram_update_id IN (${placeholders})
       LIMIT 1`,
    )
    .bind(...updateIds)
    .first<AssistantRow>();
}

async function saveAssistantAndAttach(
  db: D1Database,
  input: {
    ownerId: number;
    conversationId: number;
    mode: "persona" | "ask" | "system";
    content: string;
    inputTokens: number;
    outputTokens: number;
    updateIds: number[];
    now: number;
  },
): Promise<number> {
  const updatePlaceholders = input.updateIds.map(() => "?").join(",");
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO messages (
           owner_id, conversation_id, role, mode, content,
           input_tokens, output_tokens, created_at
         ) SELECT ?, ?, 'assistant', ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM conversations
           WHERE id = ? AND owner_id = ? AND status = 'active'
         )`,
      )
      .bind(
        input.ownerId,
        input.conversationId,
        input.mode,
        input.content,
        input.inputTokens,
        input.outputTokens,
        input.now,
        input.conversationId,
        input.ownerId,
      ),
    db
      .prepare(
        `UPDATE conversations
         SET message_count = message_count + 1, updated_at = ?
         WHERE id = ? AND owner_id = ? AND status = 'active'`,
      )
      .bind(input.now, input.conversationId, input.ownerId),
    db
      .prepare(
        `UPDATE processed_updates
         SET assistant_message_id = last_insert_rowid(), status = 'processing',
             updated_at = ?
         WHERE owner_id = ? AND telegram_update_id IN (${updatePlaceholders})`,
      )
      .bind(input.now, input.ownerId, ...input.updateIds),
  ]);
  if (
    !results.every((result) => result.success) ||
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    (results[2]?.meta.changes ?? 0) !== input.updateIds.length
  ) {
    throw new Error("assistant_persist_failed");
  }
  const attached = await existingAssistant(db, input.updateIds);
  if (attached === null) throw new Error("assistant_attach_missing");
  return attached.id;
}

async function enqueueDeliveries(
  deliveries: DeliveryRecord[],
  queue: QueueSender,
  now: number,
): Promise<void> {
  const bubbles = deliveries
    .filter((delivery) => delivery.kind !== "typing")
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  const nextBubble = bubbles.find(
    (delivery) =>
      delivery.status !== "sent" && delivery.status !== "cancelled",
  );
  const previousBubble =
    nextBubble === undefined
      ? undefined
      : bubbles
          .filter(
            (delivery) =>
              delivery.chunkIndex < nextBubble.chunkIndex &&
              delivery.status === "sent",
          )
          .at(-1);

  for (const delivery of deliveries) {
    if (
      delivery.status === "sent" ||
      delivery.status === "cancelled" ||
      delivery.status === "sending" ||
      (delivery.kind !== "typing" && delivery.deliveryId !== nextBubble?.deliveryId)
    ) {
      continue;
    }
    const job: QueueJob = {
      type: delivery.kind === "typing" ? "typing" : "bubble",
      deliveryId: delivery.deliveryId,
    };
    const delaySeconds =
      delivery.kind !== "typing" && previousBubble !== undefined
        ? nextBubbleDelaySeconds(delivery.targetAt, previousBubble.targetAt)
        : Math.max(0, Math.ceil(delivery.targetAt - now));
    await queue.send(job, {
      delaySeconds,
    });
  }
}

async function buildAndStoreDeliveryPlan(
  db: D1Database,
  input: {
    ownerId: number;
    assistantMessageId: number;
    chatId: number;
    content: string;
    flow: MessageFlow;
    mode: "persona" | "ask";
    now: number;
    random: RandomSource;
    enterBusy: boolean;
  },
): Promise<DeliveryRecord[]> {
  const bubbles = splitSemanticBubbles(input.content, input.flow);
  if (input.enterBusy) bubbles.push(BUSY_MESSAGE);
  const initialDelay =
    input.mode === "ask"
      ? 0
      : calculateInitialDelaySeconds(input.flow, input.random);
  let targetAt = input.now + initialDelay;
  const bubbleTargets = bubbles.map((text, index) => {
    if (index > 0) targetAt += calculateBubbleGapSeconds(input.random);
    return { text, targetAt };
  });
  const typingTargets: number[] = [];
  if (initialDelay > 0) {
    for (let offset = 0; offset < initialDelay; offset += 5) {
      typingTargets.push(input.now + offset);
    }
  }
  return createDeliveryPlan(db, {
    ownerId: input.ownerId,
    assistantMessageId: input.assistantMessageId,
    targetChatId: input.chatId,
    typingTargets,
    bubbles: bubbleTargets,
    now: input.now,
  });
}

async function processReplyGroup(
  sources: SourceMessageRow[],
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  if (sources.length === 0) return;
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const queue = queueSender(env, dependencies);
  const random = dependencies.random ?? cryptoRandom;
  const ownerId = sources[0]!.owner_id;
  const conversationId = sources.at(-1)!.conversation_id;
  const updateIds = sources.map((source) => source.telegram_update_id);
  const mode = sources.some((source) => source.mode === "ask") ? "ask" : "persona";
  if (mode === "persona") {
    await noteUserReply(env.DB, ownerId, now);
    await attachProactiveOutcome(env.DB, ownerId, now);
  }
  const combinedContent = sources.map((source) => source.content).join("\n");
  const flow = classifyMessageFlow(combinedContent);
  const dialogue = classifyDialogue(combinedContent);

  const priorAssistant = await existingAssistant(env.DB, updateIds);
  if (priorAssistant !== null) {
    let deliveries = await getDeliveriesForAssistant(env.DB, priorAssistant.id);
    if (deliveries.length === 0) {
      const owner = await getOwner(env.DB);
      if (owner === null || owner.ownerId !== ownerId) return;
      deliveries = await buildAndStoreDeliveryPlan(env.DB, {
        ownerId,
        assistantMessageId: priorAssistant.id,
        chatId: owner.telegramChatId,
        content: priorAssistant.content,
        flow,
        mode,
        now,
        random,
        enterBusy: false,
      });
    }
    await enqueueDeliveries(deliveries, queue, now);
    return;
  }

  for (const source of sources) {
    await markUpdate(env.DB, source.telegram_update_id, "processing", now);
  }
  const owner = await getOwner(env.DB);
  if (owner === null || owner.ownerId !== ownerId) return;

  const dailyLimit =
    dependencies.dailyMessageLimit ?? Number(env.DAILY_MESSAGE_LIMIT);
  const reserved = await reserveDailyRequest(
    env.DB,
    ownerId,
    utcDate(now),
    dailyLimit,
  );
  let answer = DAILY_LIMIT_MESSAGE;
  let inputTokens = 0;
  let outputTokens = 0;
  let promptCacheHitTokens = 0;
  let promptCacheMissTokens = 0;
  let usedMemoryRefs: Array<{ kind: "fact" | "episode"; id: number }> = [];
  let recallItems: RankedMemoryCandidate[] = [];
  let recallPersonaVersion = 0;
  let recallExplicitHistory = false;
  if (reserved) {
    try {
      if (mode === "ask") {
        const response = await requestChat(
          thinkingDeepSeekOptions(env, dependencies),
          buildAskPrompt({
            question: combinedContent,
            currentBeijingTime: beijingTime(now),
          }).messages,
        );
        answer = response.content;
        inputTokens = response.usage.inputTokens;
        outputTokens = response.usage.outputTokens;
        promptCacheHitTokens = response.usage.promptCacheHitTokens;
        promptCacheMissTokens = response.usage.promptCacheMissTokens;
      } else {
        const persona = await getCurrentPersona(env.DB, ownerId);
        if (persona === null || !persona.enabled) {
          answer = "Persona 人格当前不可用。";
        } else {
          const services = semanticServices(env, dependencies);
          recallExplicitHistory = explicitlyRequestsHistory(combinedContent);
          const [d1MemoryFacts, semanticMemoryFacts, graphMemories, summary, recent, relationshipStates, replyFeedback, timeMemories, interactionPreferences, conversationSignals, evidenceReflections, identityCore] = await Promise.all([
            getRelevantMemoryFacts(env.DB, ownerId, combinedContent, 20, now),
            services === null
              ? Promise.resolve([])
              : getSemanticRelevantMemories(
                  env.DB,
                  services.ai,
                  services.index,
                  ownerId,
                  combinedContent,
                  now,
                  recallExplicitHistory,
                ),
            getGraphCandidates(env.DB, ownerId, combinedContent, 20).catch(() => []),
            getLatestConversationSummary(env.DB, conversationId),
            getRecentMessages(env.DB, conversationId, 30),
            getActiveRelationshipStates(env.DB, ownerId, now),
            getRecentReplyFeedback(env.DB, ownerId, now),
            getRelevantTimeMemories(env.DB, ownerId, conversationId, combinedContent, now),
            getConfirmedInteractionPreferences(env.DB, ownerId),
            getConversationSignals(env.DB, ownerId, conversationId, now),
            getRecentEvidenceReflections(env.DB, ownerId),
            getActiveIdentityCore(env.DB, ownerId),
          ]);
          const merged = mergeMemories(d1MemoryFacts, semanticMemoryFacts, 30);
          const ordinaryCandidates = merged.flatMap((memory) => {
            const candidate = retrievalCandidate(memory, now);
            return candidate === null ? [] : [candidate];
          });
          const graphCandidates: MemoryRetrievalCandidate[] = graphMemories.map((memory) => ({
            entityKind: "graph",
            entityId: memory.id,
            factKey: memory.key,
            factValue: memory.value,
            category: memory.type,
            confidence: memory.confidence,
            channel: "graph",
            relevanceScore: 500,
            updatedAt: memory.updatedAt,
            sourceMessageId: memory.sourceMessageId,
            status: "active",
            control: "normal",
          }));
          recallItems = rankMemoryCandidates(
            [...ordinaryCandidates, ...graphCandidates],
            { now, limit: 20, explicitHistory: recallExplicitHistory },
          );
          recallPersonaVersion = persona.version;
          const memoryFacts = recallItems.map(promptMemory);
          const sourceIds = new Set(sources.map((source) => source.id));
          const builtPrompt = buildPersonaPrompt({
              persona: persona.snapshot,
              memoryFacts,
              timeMemories,
              relationshipStates,
              replyFeedback,
              interactionPreferences,
              conversationSignals,
              evidenceReflections,
              identityCore,
              temporaryRepair: detectRepairSignal({ text: combinedContent }),
              summary: summary?.summary ?? null,
              recentMessages: recent
                .filter(
                  (message) =>
                    !sourceIds.has(message.messageId) && message.mode === "persona",
                )
                .map((message) => ({ role: message.role, content: message.content })),
              currentMessage: combinedContent,
              currentBeijingTime: beijingTime(now),
              maxContextChars: 48_000,
              dialogue,
            });
          usedMemoryRefs = builtPrompt.usedMemoryRefs;
          const response = await requestChat(
            deepSeekOptions(
              env,
              dependencies,
              replyOutputTokenBudget(Number(env.MAX_OUTPUT_TOKENS), flow),
            ),
            builtPrompt.messages,
          );
          answer = sanitizePersonaReply(response.content);
          inputTokens = response.usage.inputTokens;
          outputTokens = response.usage.outputTokens;
          promptCacheHitTokens = response.usage.promptCacheHitTokens;
          promptCacheMissTokens = response.usage.promptCacheMissTokens;
        }
      }
      await addDailyTokenUsage(
        env.DB,
        ownerId,
        utcDate(now),
        inputTokens,
        outputTokens,
        promptCacheHitTokens,
        promptCacheMissTokens,
      );
    } catch (error) {
      if (!(error instanceof DeepSeekError) || error.code !== "invalid_response") {
        throw error;
      }
      answer = "刚刚没响应出来，你再发我一次嘛。";
    }
  }

  const assistantMessageId = await saveAssistantAndAttach(env.DB, {
    ownerId,
    conversationId,
    mode,
    content: answer,
    inputTokens,
    outputTokens,
    updateIds,
    now,
  });
  if (mode === "persona") {
    try {
      await saveRecallTrace(env.DB, {
        ownerId,
        conversationId,
        assistantMessageId,
        queryHash: await sha256Hex(combinedContent),
        explicitHistory: recallExplicitHistory,
        model: env.DEEPSEEK_MODEL,
        personaVersion: recallPersonaVersion,
        items: recallItems,
        now,
      });
      await recordQualityEvent(env, {
        ownerId, category: "retrieval", reasonCode: "hybrid_recall",
        metrics: { selected_count: recallItems.length, explicit_history: recallExplicitHistory ? 1 : 0 },
        modelVersion: env.DEEPSEEK_MODEL, personaVersion: recallPersonaVersion,
        workerVersion: "runtime", now,
      });
    } catch (error) {
      safeLog({
        eventHash: await sha256Hex(`recall_trace:${ownerId}:${assistantMessageId}`),
        stage: "memory_recall_trace",
        durationMs: 0,
        httpStatus: null,
        errorCode: error instanceof Error ? error.message : "memory_recall_trace_failed",
        inputTokens: null,
        outputTokens: null,
        chunkCount: null,
        personaHash: null,
      });
    }
  }
  const enterBusy =
    mode === "persona" &&
    shouldEnterBusy(
      flow,
      random,
      dependencies.busyProbabilityPercent ?? 1,
    );
  if (enterBusy) {
    await setBusyUntil(
      env.DB,
      ownerId,
      now + calculateBusyDurationSeconds(random),
      now,
    );
  }
  const deliveries = await buildAndStoreDeliveryPlan(env.DB, {
    ownerId,
    assistantMessageId,
    chatId: owner.telegramChatId,
    content: answer,
    flow,
    mode,
    now,
    random,
    enterBusy,
  });
  if (mode === "persona") {
    const bubbleCount = deliveries.filter((delivery) => delivery.kind !== "typing").length;
    await recordReplyContext(env.DB, {
      ownerId,
      assistantMessageId,
      intent: dialogue.intent,
      stage: dialogue.stage,
      memoryRefs: usedMemoryRefs,
      bubbleCount,
      charCount: answer.length,
      candidate: isAdjustmentCandidate({
        intent: dialogue.intent,
        usedMemory: usedMemoryRefs.length > 0,
        bubbleCount,
        charCount: answer.length,
      }),
      now,
    });
  }
  await enqueueDeliveries(deliveries, queue, now);

  const unsummarizedMessages = mode === "persona"
    ? await countUnsummarizedPersonaMessages(env.DB, conversationId)
    : 0;
  if (
    mode === "persona" &&
    unsummarizedMessages >=
      Math.max(1, Number(env.MEMORY_UPDATE_INTERVAL)) * 2
  ) {
    await queue.send({ type: "memory_update", ownerId, conversationId });
  }
}

async function attachImageDescription(
  job: Extract<QueueJob, { type: "chat" }>,
  messageId: number,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  if (job.imageKey === undefined) return;
  const cached = await env.IMAGE_CACHE.get(job.imageKey, "text").catch(() => null);
  if (cached === null) return;
  await env.IMAGE_CACHE.delete(job.imageKey).catch(() => undefined);
  const row = await env.DB.prepare(
    "SELECT content FROM messages WHERE id = ?",
  ).bind(messageId).first<{ content: string }>();
  if (row === null || row.content.includes("图片描述")) return;
  const vision =
    dependencies.vision ??
    (async (base64: string) =>
      describeImage(env.AI as unknown as VisionAi, env.VISION_MODEL, base64));
  let description: string | null = null;
  try {
    description = await vision(cached);
  } catch {
    description = null;
  }
  const marker =
    description === null
      ? "[图片描述：无法识别]"
      : `[图片描述：${description}]`;
  const updated =
    row.content.length === 0 || row.content === "[图片]"
      ? marker
      : `${row.content}\n${marker}`;
  await env.DB.prepare(
    "UPDATE messages SET content = ? WHERE id = ?",
  ).bind(updated, messageId).run();
}

async function processChat(
  job: Extract<QueueJob, { type: "chat" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const source = await loadSourceMessage(env.DB, job);
  if (source === null) return;
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  if (job.imageKey !== undefined) {
    await attachImageDescription(job, source.id, env, dependencies);
  }
  if (job.mode === "persona" && isPersonaCorrectionText(source.content)) {
    await processPersonaDraft(
      {
        type: "persona_draft",
        operation: "correction",
        ownerId: job.ownerId,
        telegramUpdateId: job.telegramUpdateId,
        messageId: job.messageId,
      },
      env,
      dependencies,
    );
    return;
  }
  const flow = classifyMessageFlow(source.content);
  const runtime = await getRuntimeState(env.DB, job.ownerId);
  if (
    job.mode === "persona" &&
    flow !== "safety" &&
    runtime?.busyUntil !== null &&
    runtime?.busyUntil !== undefined &&
    runtime.busyUntil > now
  ) {
    await queueSender(env, dependencies).send(
      { type: "busy_resume", ownerId: job.ownerId },
      { delaySeconds: Math.ceil(runtime.busyUntil - now) },
    );
    return;
  }
  const grouped = job.mode === "persona"
      ? await env.DB.prepare(
          `SELECT messages.id, messages.owner_id, messages.conversation_id,
                  messages.content, messages.mode, messages.telegram_update_id,
                  processed_updates.status
           FROM messages JOIN processed_updates
             ON processed_updates.telegram_update_id = messages.telegram_update_id
           WHERE messages.owner_id = ? AND messages.conversation_id = ?
             AND messages.role = 'user' AND messages.mode = 'persona'
             AND processed_updates.status IN ('queued', 'received')
             AND processed_updates.assistant_message_id IS NULL
           ORDER BY messages.id LIMIT 12`,
        ).bind(job.ownerId, source.conversation_id).all<PendingBusyRow>()
      : { results: [source] };
  const groupedSources = grouped.results.length > 0 ? grouped.results : [source];
  try {
    await processReplyGroup(groupedSources, env, dependencies);
  } catch (error) {
    await markSourcesFailed(env.DB, groupedSources, error, now);
    throw error;
  }
}

async function processPersonaDraft(
  job: Extract<QueueJob, { type: "persona_draft" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const source = await loadSourceMessage(env.DB, job);
  if (source === null) return;
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  try {
    const priorAssistant = await existingAssistant(env.DB, [job.telegramUpdateId]);
    if (priorAssistant !== null) {
      await enqueueDeliveries(
        await getDeliveriesForAssistant(env.DB, priorAssistant.id),
        queueSender(env, dependencies),
        now,
      );
      return;
    }
    await markUpdate(env.DB, job.telegramUpdateId, "processing", now);
    const persona = await getCurrentPersona(env.DB, job.ownerId);
    const owner = await getOwner(env.DB);
    if (persona === null || owner === null || owner.ownerId !== job.ownerId) {
      throw new QueueProcessingError("persona_not_available", false);
    }
    const reserved = await reserveDailyRequest(
      env.DB,
      job.ownerId,
      utcDate(now),
      dependencies.dailyMessageLimit ?? Number(env.DAILY_MESSAGE_LIMIT),
    );
    if (!reserved) throw new QueueProcessingError("daily_limit", false);
    const proposal = await requestPersonaDraft(
      structuredDeepSeekOptions(env, dependencies),
      {
        operation: job.operation,
        currentSnapshot: persona.snapshot,
        triggerText: source.content,
      },
    );
    const patch = materializePersonaPatch(persona.snapshot, proposal.operations);
    const draft = await createPersonaDraft(env.DB, {
      ownerId: job.ownerId,
      operation: job.operation,
      summary: proposal.summary,
      impactScope: proposal.impactScope,
      patch,
      sourceMessageId: source.id,
      now,
    });
    await addDailyTokenUsage(
      env.DB,
      job.ownerId,
      utcDate(now),
      proposal.usage.inputTokens,
      proposal.usage.outputTokens,
      proposal.usage.promptCacheHitTokens,
      proposal.usage.promptCacheMissTokens,
    );
    const confirmationText =
      job.operation === "correction" ? "确认修正" : "确认新增";
    const answer =
      job.operation === "addition"
        ? `人格新增草稿\n实际写入：\n${proposal.operations
            .flatMap((operation) =>
              (Array.isArray(operation.value) ? operation.value : [operation.value]).map(
                (value) => `- ${operation.path}：${value}`,
              ),
            )
            .join("\n")}\n请使用下方按钮选择操作。`
        : `人格修正草稿：${proposal.summary}\n影响范围：${proposal.impactScope}\n请使用下方按钮选择操作。`;
    const appUrl = new URL("/app", env.PUBLIC_BASE_URL);
    appUrl.hash = `draft=${draft.draftId}`;
    await createTelegramClient(
      env.TELEGRAM_BOT_TOKEN,
      dependencies.fetcher,
    ).sendMessage(owner.telegramChatId, "人格草稿已生成，请选择操作", {
      replyMarkup: {
        inline_keyboard: [
          [
            { text: confirmationText, callback_data: `pd:c:${draft.draftId}` },
            { text: "重新生成", callback_data: `pd:r:${draft.draftId}` },
          ],
          [
            { text: "手动修改", web_app: { url: appUrl.toString() } },
            { text: "取消", callback_data: `pd:x:${draft.draftId}` },
          ],
        ],
      },
    });
    const assistantMessageId = await saveAssistantAndAttach(env.DB, {
      ownerId: job.ownerId,
      conversationId: source.conversation_id,
      mode: "system",
      content: answer,
      inputTokens: proposal.usage.inputTokens,
      outputTokens: proposal.usage.outputTokens,
      updateIds: [job.telegramUpdateId],
      now,
    });
    const deliveries = await buildAndStoreDeliveryPlan(env.DB, {
      ownerId: job.ownerId,
      assistantMessageId,
      chatId: owner.telegramChatId,
      content: answer,
      flow: "normal",
      mode: "ask",
      now,
      random: dependencies.random ?? cryptoRandom,
      enterBusy: false,
    });
    await enqueueDeliveries(deliveries, queueSender(env, dependencies), now);
  } catch (error) {
    if (
      error instanceof DeepSeekError &&
      (error.code === "invalid_persona_draft" || error.code === "invalid_response")
    ) {
      const owner = await getOwner(env.DB);
      if (owner !== null && owner.ownerId === job.ownerId) {
        try {
          await createTelegramClient(
            env.TELEGRAM_BOT_TOKEN,
            dependencies.fetcher,
          ).sendMessage(
            owner.telegramChatId,
            "人格草稿生成失败了，请稍后重新发送 /persona-add。",
          );
        } catch {
          // Preserve the original draft error for queue classification.
        }
      }
    }
    await markSourcesFailed(env.DB, [source], error, now);
    throw error;
  }
}

async function markSourcesFailed(
  db: D1Database,
  sources: SourceMessageRow[],
  error: unknown,
  now: number,
): Promise<void> {
  const errorCode =
    error instanceof DeepSeekError || error instanceof QueueProcessingError
      ? error instanceof DeepSeekError &&
        error.code === "invalid_persona_draft" &&
        error.detail
        ? `${error.code}:${error.detail}`
        : error.code
      : "queue_processing_failed";
  for (const source of sources) {
    await markUpdate(db, source.telegram_update_id, "failed", now, errorCode);
  }
}

async function processBusyResume(
  ownerId: number,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const runtime = await getRuntimeState(env.DB, ownerId);
  if (runtime?.busyUntil !== null && runtime?.busyUntil !== undefined && runtime.busyUntil > now) {
    await queueSender(env, dependencies).send(
      { type: "busy_resume", ownerId },
      { delaySeconds: Math.ceil(runtime.busyUntil - now) },
    );
    return;
  }
  await clearBusyIfDue(env.DB, ownerId, now);
  const pending = await env.DB
    .prepare(
      `SELECT messages.id, messages.owner_id, messages.conversation_id,
              messages.content, messages.mode, messages.telegram_update_id,
              processed_updates.status
       FROM messages
       JOIN processed_updates
         ON processed_updates.telegram_update_id = messages.telegram_update_id
       WHERE messages.owner_id = ? AND messages.role = 'user'
         AND messages.mode = 'persona'
         AND processed_updates.status IN ('queued', 'received', 'failed')
         AND (processed_updates.last_error_code IS NULL OR processed_updates.last_error_code NOT IN ('dlq_exhausted'))
         AND processed_updates.assistant_message_id IS NULL
       ORDER BY messages.id`,
    )
    .bind(ownerId)
    .all<PendingBusyRow>();
  try {
    await processReplyGroup(pending.results, env, dependencies);
  } catch (error) {
    await markSourcesFailed(env.DB, pending.results, error, now);
    throw error;
  }
}

async function continueBubbleSequence(
  delivery: DeliveryRecord,
  env: Env,
  dependencies: QueueDependencies,
  now: number,
): Promise<void> {
  const deliveries = await getDeliveriesForAssistant(
    env.DB,
    delivery.assistantMessageId,
  );
  await enqueueDeliveries(
    deliveries.filter((candidate) => candidate.kind !== "typing"),
    queueSender(env, dependencies),
    now,
  );
  if (await allBubblesSent(env.DB, delivery.assistantMessageId)) {
    await env.DB
      .prepare(
        `UPDATE processed_updates
         SET status = 'completed', updated_at = ?, last_error_code = NULL
         WHERE assistant_message_id = ?`,
      )
      .bind(now, delivery.assistantMessageId)
      .run();
  }
}

async function processDelivery(
  deliveryId: number,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const delivery = await getDelivery(env.DB, deliveryId);
  if (delivery === null || delivery.status === "cancelled") {
    return;
  }
  if (delivery.status === "sent") {
    if (delivery.kind !== "typing") {
      try {
        await continueBubbleSequence(delivery, env, dependencies, now);
      } catch {
        throw new QueueProcessingError("queue_send_failed", true);
      }
    }
    return;
  }
  if (!(await markDeliverySending(env.DB, deliveryId, now))) return;
  const telegram = createTelegramClient(env.TELEGRAM_BOT_TOKEN, dependencies.fetcher);
  try {
    if (delivery.kind === "typing") {
      await telegram.sendTyping(delivery.targetChatId);
      await markDeliverySent(env.DB, deliveryId, null, now);
      return;
    }
    if (delivery.chunkText === null) throw new Error("delivery_text_missing");
    const showAdjustment = await isLastBubbleDelivery(
        env.DB,
        delivery.assistantMessageId,
        delivery.chunkIndex,
      ) &&
      await canShowAutomaticAdjustment(
        env.DB,
        delivery.ownerId,
        delivery.assistantMessageId,
        now,
      );
    const result = await telegram.sendMessage(
      delivery.targetChatId,
      delivery.chunkText,
      showAdjustment
        ? { replyMarkup: { inline_keyboard: [[{
            text: "调整",
            callback_data: `ra:o:${delivery.assistantMessageId}`,
          }]] } }
        : undefined,
    );
    await markDeliverySent(env.DB, deliveryId, result.messageId, now);
    if (showAdjustment) {
      await markAdjustmentShown(
        env.DB,
        delivery.ownerId,
        delivery.assistantMessageId,
        now,
      );
    }
  } catch (error) {
    const code = error instanceof TelegramError ? error.code : "delivery_error";
    const retryable = error instanceof TelegramError ? error.retryable : false;
    await markDeliveryFailed(env.DB, deliveryId, code, now);
    throw new QueueProcessingError(
      code === "http_429" ? "rate_limited" : code,
      retryable,
    );
  }
  try {
    await continueBubbleSequence(delivery, env, dependencies, now);
  } catch {
    throw new QueueProcessingError("queue_send_failed", true);
  }
}

async function processMemoryUpdate(
  job: Extract<QueueJob, { type: "memory_update" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  try {
    const latest = await getLatestConversationSummary(env.DB, job.conversationId);
    const messages = await getPersonaMessagesAfter(
      env.DB,
      job.conversationId,
      latest?.throughMessageId ?? 0,
      40,
    );
    const sourceMessages = messages
      .map((message) => ({
        id: message.messageId,
        role: message.role,
        content: message.content,
      }));
    if (sourceMessages.length === 0) return;
    const userSourceMessages = sourceMessages.filter((message) => message.role === "user");
    const firstUserSource = userSourceMessages.at(0);
    const lastUserSource = userSourceMessages.at(-1);
    const timeMemoryContext = await getTimeMemoryUpdateContext(
      env.DB,
      job.ownerId,
      job.conversationId,
      now,
    );
    const result = await requestMemoryUpdate(
      structuredDeepSeekOptions(env, dependencies),
      {
        previousSummary: latest?.summary ?? null,
        previousTimeLayers: timeMemoryContext.previous,
        sourceMessages,
      },
    );
  const saved = await saveMemoryExtraction(env.DB, {
    ownerId: job.ownerId,
    conversationId: job.conversationId,
    stableFacts: result.stableFacts,
    episodes: result.episodes,
    now,
  });
  await saveRelationshipStates(env.DB, {
    ownerId: job.ownerId,
    conversationId: job.conversationId,
    states: result.relationshipStates,
    now,
  });
  try {
    await upsertMemoryGraph(env.DB, {
      ownerId: job.ownerId,
      nodes: result.graphNodes,
      edges: result.graphEdges,
      now,
    });
  } catch (error) {
    safeLog({
      eventHash: await sha256Hex(`memory_graph:${job.ownerId}:${job.conversationId}:${now}`),
      stage: "memory_graph",
      durationMs: 0,
      httpStatus: null,
      errorCode: error instanceof Error ? error.message : "memory_graph_failed",
      inputTokens: null,
      outputTokens: null,
      chunkCount: null,
      personaHash: null,
    });
  }
  for (const evidence of result.identityEvidence) {
    try {
      await recordIdentityEvidence(env.DB, {
        ownerId: job.ownerId,
        identityKey: evidence.identityKey,
        identityValue: evidence.identityValue,
        sourceMessageId: evidence.sourceMessageId,
        now,
      });
    } catch (error) {
      safeLog({
        eventHash: await sha256Hex(`identity_evidence:${job.ownerId}:${evidence.sourceMessageId}`),
        stage: "identity_evidence",
        durationMs: 0,
        httpStatus: null,
        errorCode: error instanceof Error ? error.message : "identity_evidence_failed",
        inputTokens: null,
        outputTokens: null,
        chunkCount: null,
        personaHash: null,
      });
    }
  }
  await saveEvidenceReflection(env.DB, {
    ownerId: job.ownerId,
    conversationId: job.conversationId,
    relationshipStates: result.relationshipStates,
    now,
  });
  if (firstUserSource !== undefined && lastUserSource !== undefined) {
    await saveTimeMemories(env.DB, {
      ownerId: job.ownerId,
      conversationId: job.conversationId,
      keys: timeMemoryContext.keys,
      layers: result.timeLayers,
      fromMessageId: firstUserSource.id,
      throughMessageId: lastUserSource.id,
      now,
    });
  }
  await saveConversationSummary(env.DB, {
    conversationId: job.conversationId,
    fromMessageId: sourceMessages[0]!.id,
    throughMessageId: result.throughMessageId,
    summary: result.summary,
    createdAt: now,
  });
  const sender = queueSender(env, dependencies);
  for (const _jobId of saved.vectorJobIds) {
    await sender.send({ type: "memory_vector_sync", ownerId: job.ownerId });
  }
  if (saved.conflicts.length > 0) {
    const owner = await getOwner(env.DB);
    if (owner !== null && owner.ownerId === job.ownerId) {
      const telegram = createTelegramClient(env.TELEGRAM_BOT_TOKEN, dependencies.fetcher);
      for (const conflict of saved.conflicts) {
        const appUrl = new URL("/app", env.PUBLIC_BASE_URL);
        appUrl.hash = `memory-conflict=${conflict.conflictId}`;
        await telegram.sendMessage(
          owner.telegramChatId,
          `发现一条可能冲突的长期记忆：\n原记忆：${conflict.oldValue}\n新记忆：${conflict.newValue}`,
          {
            replyMarkup: {
              inline_keyboard: [
                [
                  { text: "使用新记忆", callback_data: `mc:n:${conflict.conflictId}` },
                  { text: "保留原记忆", callback_data: `mc:k:${conflict.conflictId}` },
                ],
                [{ text: "手动修改", web_app: { url: appUrl.toString() } }],
              ],
            },
          },
        );
      }
    }
  }
  await addDailyTokenUsage(
    env.DB,
    job.ownerId,
    utcDate(now),
    result.usage.inputTokens,
    result.usage.outputTokens,
    result.usage.promptCacheHitTokens,
    result.usage.promptCacheMissTokens,
  );
    await clearMemoryUpdateFailure(env.DB, job.ownerId, job.conversationId);
  } catch (error) {
    if (error instanceof DeepSeekError && !error.retryable) {
      await recordMemoryUpdateFailure(env.DB, {
        ownerId: job.ownerId,
        conversationId: job.conversationId,
        errorCode: error.code,
        now,
      });
      return;
    }
    throw error;
  }
}

async function processMemoryVectorSync(
  job: Extract<QueueJob, { type: "memory_vector_sync" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const services = semanticServices(env, dependencies);
  if (services === null) return;
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const claimed = await claimVectorSyncJob(env.DB, job.ownerId, now);
  if (claimed === null) return;
  try {
    await syncVectorJob(env.DB, services.ai, services.index, claimed, now);
  } catch {
    throw new QueueProcessingError("vector_sync_failed", true);
  }
}

async function processReminderDelivery(
  job: Extract<QueueJob, { type: "reminder_delivery" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const reminder = await claimReminderDelivery(env.DB, job.reminderId, job.ownerId, now);
  if (reminder === null) return;
  if (reminder.dueAt > now + 60) {
    await releaseReminderClaim(env.DB, reminder.id, job.ownerId, now, now);
    return;
  }
  const owner = await getOwner(env.DB);
  if (owner === null || owner.ownerId !== job.ownerId) {
    await releaseReminderClaim(env.DB, reminder.id, job.ownerId, now, now);
    return;
  }
  try {
    await createTelegramClient(env.TELEGRAM_BOT_TOKEN, dependencies.fetcher)
      .sendMessage(owner.telegramChatId, `⏰ ${reminder.content}`);
    await markReminderSent(env.DB, reminder.id, job.ownerId, now);
  } catch (error) {
    await releaseReminderClaim(env.DB, reminder.id, job.ownerId, now, now);
    throw new QueueProcessingError(
      error instanceof TelegramError && error.code === "http_429"
        ? "rate_limited"
        : "reminder_send_failed",
      !(error instanceof TelegramError) || error.retryable,
    );
  }
}

interface WeeklyReviewRow {
  id: number;
  period_start: number;
  period_end: number;
  status: "queued" | "sent" | "failed";
  assistant_message_id: number | null;
}

async function processWeeklyReview(
  job: Extract<QueueJob, { type: "weekly_review" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const review = await env.DB.prepare(
    `SELECT id, period_start, period_end, status, assistant_message_id
     FROM weekly_reviews WHERE owner_id = ? AND week_key = ?`,
  ).bind(job.ownerId, job.weekKey).first<WeeklyReviewRow>();
  if (review === null || review.status === "sent") return;
  const owner = await getOwner(env.DB);
  const persona = await getCurrentPersona(env.DB, job.ownerId);
  if (owner === null || owner.ownerId !== job.ownerId || persona === null || !persona.enabled) {
    return;
  }

  let assistant = review.assistant_message_id === null
    ? null
    : await env.DB.prepare(
        `SELECT id, conversation_id, content FROM messages
         WHERE id = ? AND owner_id = ? AND role = 'assistant'`,
      ).bind(review.assistant_message_id, job.ownerId).first<AssistantRow>();
  if (assistant === null) {
    const rows = await env.DB.prepare(
      `SELECT role, content FROM messages
       WHERE owner_id = ? AND mode = 'persona' AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).bind(job.ownerId, review.period_start, review.period_end)
      .all<{ role: "user" | "assistant"; content: string }>();
    const messages = rows.results.reverse();
    if (messages.length === 0) {
      await env.DB.prepare(
        `UPDATE weekly_reviews SET status = 'sent', updated_at = ? WHERE id = ?`,
      ).bind(now, review.id).run();
      return;
    }
    const reserved = await reserveDailyRequest(
      env.DB,
      job.ownerId,
      utcDate(now),
      dependencies.dailyMessageLimit ?? Number(env.DAILY_MESSAGE_LIMIT),
    );
    if (!reserved) throw new QueueProcessingError("daily_limit", true);
    const transcript = messages
      .map((message) => `${message.role === "user" ? "Kami" : "Persona"}：${message.content}`)
      .join("\n")
      .slice(-40_000);
    const response = await requestChat(deepSeekOptions(env, dependencies), [
      {
        role: "system",
        content:
          "你是 Persona。根据提供的最近七天真实聊天，写一段很短、自然、温柔的每周回顾：提到一两件确实聊过的事和对方的情绪或进展，可以自然鼓励，但不要列清单、不要说自己在做周报、不要虚构。控制在约100个中文字符。",
      },
      { role: "user", content: transcript },
    ]);
    await addDailyTokenUsage(
      env.DB,
      job.ownerId,
      utcDate(now),
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.usage.promptCacheHitTokens,
      response.usage.promptCacheMissTokens,
    );
    const conversation = await getOrCreateActiveConversation(env.DB, job.ownerId, now);
    const stored = await appendMessage(env.DB, {
      ownerId: job.ownerId,
      conversationId: conversation.conversationId,
      role: "assistant",
      mode: "persona",
      content: sanitizePersonaReply(response.content),
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      createdAt: now,
    });
    assistant = {
      id: stored.messageId,
      conversation_id: stored.conversationId,
      content: stored.content,
    };
    await env.DB.prepare(
      `UPDATE weekly_reviews SET assistant_message_id = ?, updated_at = ? WHERE id = ?`,
    ).bind(assistant.id, now, review.id).run();
  }

  let deliveries = await getDeliveriesForAssistant(env.DB, assistant.id);
  if (deliveries.length === 0) {
    deliveries = await buildAndStoreDeliveryPlan(env.DB, {
      ownerId: job.ownerId,
      assistantMessageId: assistant.id,
      chatId: owner.telegramChatId,
      content: assistant.content,
      flow: "comfort",
      mode: "ask",
      now,
      random: dependencies.random ?? cryptoRandom,
      enterBusy: false,
    });
  }
  await enqueueDeliveries(deliveries, queueSender(env, dependencies), now);
  await env.DB.prepare(
    `UPDATE weekly_reviews SET status = 'sent', updated_at = ? WHERE id = ?`,
  ).bind(now, review.id).run();
}

async function processProactive(
  job: Extract<QueueJob, { type: "proactive" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const owner = await getOwner(env.DB);
  const persona = await getCurrentPersona(env.DB, job.ownerId);
  if (
    owner === null ||
    owner.ownerId !== job.ownerId ||
    persona === null ||
    !persona.enabled
  ) {
    return;
  }
  if (!(await isProactiveAllowedNow(env.DB, job.ownerId, now))) return;

  let assistant = await env.DB
    .prepare(
      `SELECT id, conversation_id, content FROM messages
       WHERE owner_id = ? AND role = 'assistant' AND mode = 'persona'
         AND created_at = ? AND telegram_message_id IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(job.ownerId, job.scheduledAt)
    .first<AssistantRow>();
  if (assistant === null) {
    const reserved = await reserveDailyRequest(
      env.DB,
      job.ownerId,
      utcDate(now),
      dependencies.dailyMessageLimit ?? Number(env.DAILY_MESSAGE_LIMIT),
    );
    if (!reserved) return;
    const conversation = await getOrCreateActiveConversation(
      env.DB,
      job.ownerId,
      now,
    );
    const openThread = await getEligibleOpenThreadFollowUp(env.DB, job.ownerId, now);
    const shareCue = SAFE_PROACTIVE_SHARES[randomInteger(
      0,
      SAFE_PROACTIVE_SHARES.length - 1,
      dependencies.random ?? cryptoRandom,
    )] ?? SAFE_PROACTIVE_SHARES[0];
    const [memoryFacts, summary, recent, relationshipStates] = await Promise.all([
      getRelevantMemoryFacts(env.DB, job.ownerId, "最近 学习 生活", 12, now),
      getLatestConversationSummary(env.DB, conversation.conversationId),
      getRecentMessages(env.DB, conversation.conversationId, 20),
      getActiveRelationshipStates(env.DB, job.ownerId, now),
    ]);
    const prompt = buildPersonaPrompt({
      persona: persona.snapshot,
      memoryFacts,
      relationshipStates,
      summary: summary?.summary ?? null,
      recentMessages: recent
        .filter((message) => message.mode === "persona")
        .map((message) => ({ role: message.role, content: message.content })),
      currentMessage: openThread === null
        ? "[PROACTIVE_CONTACT]"
        : `[PROACTIVE_FOLLOW_UP]\n${openThread.value}`,
      currentBeijingTime: beijingTime(now),
      maxContextChars: 48_000,
    });
    prompt.messages[prompt.messages.length - 1] = openThread === null
      ? {
          role: "system",
          content:
            `[PROACTIVE_CONTACT]\n只生成一次轻量主动联系。本次安全话题提示：${shareCue}。可以自然分享一句观点而不总是提问。即使上一次主动联系没有回复，也可以换话题，但不要提及对方未回复。主动联系频率由系统调度。不得虚构 Persona 当天的经历、地点、行程或正在做的事；不催回复。`,
        }
      : {
          role: "system",
          content: `[PROACTIVE_FOLLOW_UP]\n用一条简短自然的消息问问这个未完话题后来怎么样了。不要说“我记得”或解释记忆来源；不要假设结果已经发生，不补充用户没说过的细节，不催回复。\n提炼话题：${openThread.value}\n用户原话：${openThread.sourceContent}`,
        };
    const response = await requestChat(
      deepSeekOptions(
        env,
        dependencies,
        proactiveOutputTokenBudget(Number(env.MAX_OUTPUT_TOKENS)),
      ),
      prompt.messages,
    );
    await addDailyTokenUsage(
      env.DB,
      job.ownerId,
      utcDate(now),
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.usage.promptCacheHitTokens,
      response.usage.promptCacheMissTokens,
    );
    const stored = await appendMessage(env.DB, {
      ownerId: job.ownerId,
      conversationId: conversation.conversationId,
      role: "assistant",
      mode: "persona",
      content: sanitizePersonaReply(response.content),
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      createdAt: job.scheduledAt,
    });
    if (openThread !== null) {
      await markOpenThreadFollowedUp(env.DB, job.ownerId, openThread.id, now);
    }
    assistant = {
      id: stored.messageId,
      conversation_id: stored.conversationId,
      content: stored.content,
    };
    await noteProactiveSent(env.DB, job.ownerId, now);
    await markProactiveSent(env.DB, job.ownerId, job.scheduledAt, stored.messageId);
  }

  let deliveries = await getDeliveriesForAssistant(env.DB, assistant.id);
  if (deliveries.length === 0) {
    deliveries = await buildAndStoreDeliveryPlan(env.DB, {
      ownerId: job.ownerId,
      assistantMessageId: assistant.id,
      chatId: owner.telegramChatId,
      content: assistant.content,
      flow: "normal",
      mode: "ask",
      now,
      random: dependencies.random ?? cryptoRandom,
      enterBusy: false,
    });
  }
  await enqueueDeliveries(deliveries, queueSender(env, dependencies), now);
}

async function processEphemeral(
  job: Extract<QueueJob, { type: "ephemeral" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
  const owner = await getOwner(env.DB);
  const persona = await getCurrentPersona(env.DB, job.ownerId);
  if (owner === null || owner.ownerId !== job.ownerId || persona === null || !persona.enabled) {
    await markUpdate(env.DB, job.telegramUpdateId, "failed", now, "persona_not_available");
    return;
  }
  const reserved = await reserveDailyRequest(
    env.DB, job.ownerId, utcDate(now),
    dependencies.dailyMessageLimit ?? Number(env.DAILY_MESSAGE_LIMIT),
  );
  if (!reserved) {
    await createTelegramClient(env.TELEGRAM_BOT_TOKEN, dependencies.fetcher)
      .sendMessage(job.chatId, DAILY_LIMIT_MESSAGE);
    await markUpdate(env.DB, job.telegramUpdateId, "completed", now);
    return;
  }
  const conversation = await getOrCreateActiveConversation(env.DB, job.ownerId, now);
  const recent = await getRecentMessages(env.DB, conversation.conversationId, 30);
  const lastUser = [...recent].reverse().find((message) => message.role === "user" && message.mode === "persona");
  const currentMessage = job.mode === "temp"
    ? job.content
    : `${lastUser?.content ?? "最近一句话"}\n[REDO_REQUIREMENT] ${job.content}`;
  const [memoryFacts, summary, relationshipStates, replyFeedback, timeMemories,
    interactionPreferences, conversationSignals, evidenceReflections] = await Promise.all([
    getRelevantMemoryFacts(env.DB, job.ownerId, currentMessage, 16, now),
    getLatestConversationSummary(env.DB, conversation.conversationId),
    getActiveRelationshipStates(env.DB, job.ownerId, now),
    getRecentReplyFeedback(env.DB, job.ownerId, now),
    getRelevantTimeMemories(env.DB, job.ownerId, conversation.conversationId, currentMessage, now),
    getConfirmedInteractionPreferences(env.DB, job.ownerId),
    getConversationSignals(env.DB, job.ownerId, conversation.conversationId, now),
    getRecentEvidenceReflections(env.DB, job.ownerId),
  ]);
  const prompt = buildPersonaPrompt({
    persona: persona.snapshot, memoryFacts, relationshipStates, replyFeedback,
    timeMemories, interactionPreferences, conversationSignals, evidenceReflections,
    summary: summary?.summary ?? null,
    recentMessages: recent.filter((message) => message.mode === "persona")
      .map((message) => ({ role: message.role, content: message.content })),
    currentMessage,
    currentBeijingTime: beijingTime(now),
    maxContextChars: 48_000,
  });
  if (job.mode === "redo") prompt.messages.splice(prompt.messages.length - 1, 0, {
    role: "system",
    content: "[MANUAL_REDO]\n重新回答最近一条用户消息，遵循用户给出的重试要求；不要解释这是重试。",
  });
  const response = await requestChat(
    deepSeekOptions(
      env,
      dependencies,
      replyOutputTokenBudget(
        Number(env.MAX_OUTPUT_TOKENS),
        classifyMessageFlow(currentMessage),
      ),
    ),
    prompt.messages,
  );
  const content = sanitizePersonaReply(response.content);
  const sent = await createTelegramClient(env.TELEGRAM_BOT_TOKEN, dependencies.fetcher)
    .sendMessage(job.chatId, content);
  if (job.mode === "redo") {
    await appendMessage(env.DB, {
      ownerId: job.ownerId, conversationId: conversation.conversationId,
      role: "assistant", mode: "persona", content,
      telegramMessageId: sent.messageId,
      inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
      createdAt: now,
    });
  }
  await addDailyTokenUsage(env.DB, job.ownerId, utcDate(now),
    response.usage.inputTokens, response.usage.outputTokens,
    response.usage.promptCacheHitTokens, response.usage.promptCacheMissTokens);
  await markUpdate(env.DB, job.telegramUpdateId, "completed", now);
}

export async function processQueueMessage(
  job: QueueJob,
  env: Env,
  dependencies: QueueDependencies = {},
): Promise<void> {
  switch (job.type) {
    case "chat":
      await processChat(job, env, dependencies);
      return;
    case "typing":
    case "bubble":
      await processDelivery(job.deliveryId, env, dependencies);
      return;
    case "busy_resume":
      await processBusyResume(job.ownerId, env, dependencies);
      return;
    case "memory_update":
      await processMemoryUpdate(job, env, dependencies);
      return;
    case "memory_vector_sync":
      await processMemoryVectorSync(job, env, dependencies);
      return;
    case "reminder_delivery":
      await processReminderDelivery(job, env, dependencies);
      return;
    case "weekly_review":
      await processWeeklyReview(job, env, dependencies);
      return;
    case "persona_draft":
      await processPersonaDraft(job, env, dependencies);
      return;
    case "proactive":
      await processProactive(job, env, dependencies);
      return;
    case "ephemeral":
      await processEphemeral(job, env, dependencies);
      return;
  }
}

export async function processQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isQueueJob(message.body)) {
      safeLog({
        eventHash: await sha256Hex("invalid_queue_job"),
        stage: "queue_invalid",
        durationMs: 0,
        httpStatus: null,
        errorCode: "invalid_queue_job",
        inputTokens: null,
        outputTokens: null,
        chunkCount: null,
        personaHash: null,
      });
      message.ack();
      continue;
    }
    const startedAt = Date.now();
    const eventHash = await sha256Hex(JSON.stringify(message.body));
    try {
      await processQueueMessage(message.body, env);
      safeLog({
        eventHash,
        stage: `queue_${message.body.type}`,
        durationMs: Date.now() - startedAt,
        httpStatus: null,
        errorCode: null,
        inputTokens: null,
        outputTokens: null,
        chunkCount: null,
        personaHash: null,
      });
      message.ack();
    } catch (error) {
      safeLog({
        eventHash,
        stage: `queue_${message.body.type}`,
        durationMs: Date.now() - startedAt,
        httpStatus: error instanceof DeepSeekError ? error.status : null,
        errorCode:
          error instanceof DeepSeekError || error instanceof QueueProcessingError || error instanceof TelegramError
            ? error.code
            : "queue_processing_failed",
        inputTokens: null,
        outputTokens: null,
        chunkCount: null,
        personaHash: null,
      });
      if (
        (error instanceof QueueProcessingError || error instanceof DeepSeekError) &&
        !error.retryable
      ) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function isQueueJob(value: unknown): value is QueueJob {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "chat":
      return (
        (value.mode === "persona" || value.mode === "ask") &&
        isSafeInteger(value.ownerId) &&
        isSafeInteger(value.telegramUpdateId) &&
        isSafeInteger(value.messageId)
      );
    case "typing":
    case "bubble":
      return isSafeInteger(value.deliveryId);
    case "memory_update":
      return isSafeInteger(value.ownerId) && isSafeInteger(value.conversationId);
    case "memory_vector_sync":
      return isSafeInteger(value.ownerId);
    case "reminder_delivery":
      return isSafeInteger(value.ownerId) && typeof value.reminderId === "string" && /^[0-9a-f-]{36}$/u.test(value.reminderId);
    case "weekly_review":
      return isSafeInteger(value.ownerId) && typeof value.weekKey === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.weekKey);
    case "persona_draft":
      return (
        (value.operation === "correction" || value.operation === "addition") &&
        isSafeInteger(value.ownerId) &&
        isSafeInteger(value.telegramUpdateId) &&
        isSafeInteger(value.messageId)
      );
    case "busy_resume":
      return isSafeInteger(value.ownerId);
    case "proactive":
      return isSafeInteger(value.ownerId) && isSafeInteger(value.scheduledAt);
    case "ephemeral":
      return (value.mode === "temp" || value.mode === "redo") &&
        isSafeInteger(value.ownerId) && isSafeInteger(value.telegramUpdateId) &&
        isSafeInteger(value.chatId) && typeof value.content === "string" && value.content.length <= 100_000;
    default:
      return false;
  }
}
