import {
  DeepSeekError,
  materializePersonaPatch,
  requestChat,
  requestMemoryUpdate,
  requestPersonaDraft,
  type DeepSeekOptions,
} from "./deepseek";
import { isPersonaCorrectionText } from "./commands";
import { buildAskPrompt, buildPersonaPrompt, cleanStageDirections } from "./prompt";
import { createTelegramClient, TelegramError } from "./telegram";
import {
  appendMessage,
  countUnsummarizedMessages,
  getLatestConversationSummary,
  getOrCreateActiveConversation,
  getRecentMessages,
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
import {
  clearMemoryUpdateFailure,
  recordMemoryUpdateFailure,
} from "./storage/memory-update-failure-repository";
import { saveMemoryExtraction } from "./storage/semantic-memory-repository";
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
  addDailyTokenUsage,
  reserveDailyRequest,
} from "./storage/usage-repository";
import { markUpdate } from "./storage/update-repository";
import {
  claimReminderDelivery,
  markReminderSent,
  releaseReminderClaim,
} from "./storage/reminder-repository";

export const BUSY_MESSAGE = "我先去忙啦";
const DAILY_LIMIT_MESSAGE = "今天先聊到这里吧，明天再继续呀。";

export type MessageFlow = "normal" | "comfort" | "conflict" | "safety";

export type QueueJob =
  | {
      type: "chat";
      mode: "persona" | "ask";
      ownerId: number;
      telegramUpdateId: number;
      messageId: number;
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
  | { type: "proactive"; ownerId: number; scheduledAt: number };

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

function randomInteger(
  minimum: number,
  maximum: number,
  random: RandomSource,
): number {
  const width = maximum - minimum + 1;
  return minimum + Math.floor((random.nextUint32() / 0x1_0000_0000) * width);
}

export function classifyMessageFlow(text: string): MessageFlow {
  if (/(?:自杀|自伤|不想活|杀人|立刻危险)/u.test(text)) {
    return "safety";
  }
  if (/(?:难受|焦虑|崩溃|害怕|伤心|想哭|痛苦)/u.test(text)) {
    return "comfort";
  }
  if (/(?:生气|气死|讨厌|吵架|气炸)/u.test(text)) {
    return "conflict";
  }
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

export function calculateBubbleGapSeconds(random: RandomSource): number {
  return randomInteger(2, 4, random);
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

export function splitSemanticBubbles(text: string): string[] {
  if (text.length === 0) return [];
  const rawParts = text.match(/[^。！？!?\n]+[。！？!?]*|\n+/gu) ?? [text];
  const parts: string[] = [];
  for (const part of rawParts) {
    if (part.trim().length === 0 && parts.length > 0) {
      parts[parts.length - 1] = `${parts.at(-1) ?? ""}${part}`;
    } else {
      parts.push(part);
    }
  }
  while (parts.length > 5) {
    const tail = parts.pop();
    if (tail !== undefined) parts[parts.length - 1] = `${parts.at(-1) ?? ""}${tail}`;
  }
  if (parts.length === 1 && text.length > 160) {
    const middle = Math.floor(text.length / 2);
    const candidates = [text.lastIndexOf("，", middle), text.lastIndexOf(" ", middle)];
    const splitAt = Math.max(...candidates) + 1;
    if (splitAt > 20 && splitAt < text.length - 20) {
      return [text.slice(0, splitAt), text.slice(splitAt)];
    }
  }
  return parts;
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

function deepSeekOptions(env: Env, dependencies: QueueDependencies): DeepSeekOptions {
  return {
    apiKey: env.DEEPSEEK_API_KEY,
    model: env.DEEPSEEK_MODEL,
    thinking: env.DEEPSEEK_THINKING_MODE === "enabled" ? "enabled" : "disabled",
    maxOutputTokens: Number(env.MAX_OUTPUT_TOKENS),
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
        ? Math.min(
            8,
            Math.max(4, delivery.targetAt - previousBubble.targetAt),
          )
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
  const bubbles = splitSemanticBubbles(input.content);
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
  const combinedContent = sources.map((source) => source.content).join("\n");
  const flow = classifyMessageFlow(combinedContent);

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
  if (reserved) {
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
    } else {
      const persona = await getCurrentPersona(env.DB, ownerId);
      if (persona === null || !persona.enabled) {
        answer = "Persona Bot 人格当前不可用。";
      } else {
        const services = semanticServices(env, dependencies);
        const [d1MemoryFacts, semanticMemoryFacts, summary, recent] = await Promise.all([
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
                explicitlyRequestsHistory(combinedContent),
              ),
          getLatestConversationSummary(env.DB, conversationId),
          getRecentMessages(env.DB, conversationId, 30),
        ]);
        const memoryFacts = mergeMemories(d1MemoryFacts, semanticMemoryFacts, 20);
        const sourceIds = new Set(sources.map((source) => source.id));
        const response = await requestChat(
          deepSeekOptions(env, dependencies),
          buildPersonaPrompt({
            persona: persona.snapshot,
            memoryFacts,
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
          }).messages,
        );
        answer = response.content;
        inputTokens = response.usage.inputTokens;
        outputTokens = response.usage.outputTokens;
      }
    }
    await addDailyTokenUsage(
      env.DB,
      ownerId,
      utcDate(now),
      inputTokens,
      outputTokens,
    );
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
  await enqueueDeliveries(deliveries, queue, now);

  const unsummarizedMessages = mode === "persona"
    ? await countUnsummarizedMessages(env.DB, conversationId)
    : 0;
  if (
    mode === "persona" &&
    unsummarizedMessages >=
      Math.max(1, Number(env.MEMORY_UPDATE_INTERVAL)) * 2
  ) {
    await queue.send({ type: "memory_update", ownerId, conversationId });
  }
}

async function processChat(
  job: Extract<QueueJob, { type: "chat" }>,
  env: Env,
  dependencies: QueueDependencies,
): Promise<void> {
  const source = await loadSourceMessage(env.DB, job);
  if (source === null) return;
  const now = dependencies.now?.() ?? Math.floor(Date.now() / 1_000);
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
  try {
    await processReplyGroup([source], env, dependencies);
  } catch (error) {
    await markSourcesFailed(env.DB, [source], error, now);
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
    if (error instanceof DeepSeekError && error.code === "invalid_persona_draft") {
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
    const result = await telegram.sendMessage(
      delivery.targetChatId,
      cleanStageDirections(delivery.chunkText),
    );
    await markDeliverySent(env.DB, deliveryId, result.messageId, now);
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
  const [latest, messages] = await Promise.all([
    getLatestConversationSummary(env.DB, job.conversationId),
    getRecentMessages(env.DB, job.conversationId, 40),
  ]);
  const sourceMessages = messages
    .filter(
      (message) =>
        message.mode === "persona" &&
        (latest === null || message.messageId > latest.throughMessageId),
    )
    .map((message) => ({
      id: message.messageId,
      role: message.role,
      content: message.content,
    }));
  if (sourceMessages.length === 0) return;
  const result = await requestMemoryUpdate(
    structuredDeepSeekOptions(env, dependencies),
    {
      previousSummary: latest?.summary ?? null,
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
      .map((message) => `${message.role === "user" ? "Owner" : "Persona Bot"}：${message.content}`)
      .join("\n")
      .slice(-40_000);
    const response = await requestChat(deepSeekOptions(env, dependencies), [
      {
        role: "system",
        content:
          "你是 Persona Bot。根据提供的最近七天真实聊天，写一段很短、自然、温柔的每周回顾：提到一两件确实聊过的事和对方的情绪或进展，可以自然鼓励，但不要列清单、不要说自己在做周报、不要虚构。控制在约100个中文字符。不要输出（动作）（背景）等括号旁白或舞台说明。",
      },
      { role: "user", content: transcript },
    ]);
    await addDailyTokenUsage(
      env.DB,
      job.ownerId,
      utcDate(now),
      response.usage.inputTokens,
      response.usage.outputTokens,
    );
    const conversation = await getOrCreateActiveConversation(env.DB, job.ownerId, now);
    const stored = await appendMessage(env.DB, {
      ownerId: job.ownerId,
      conversationId: conversation.conversationId,
      role: "assistant",
      mode: "persona",
      content: response.content,
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
    const [memoryFacts, summary, recent] = await Promise.all([
      getRelevantMemoryFacts(env.DB, job.ownerId, "最近 学习 生活", 12, now),
      getLatestConversationSummary(env.DB, conversation.conversationId),
      getRecentMessages(env.DB, conversation.conversationId, 20),
    ]);
    const prompt = buildPersonaPrompt({
      persona: persona.snapshot,
      memoryFacts,
      summary: summary?.summary ?? null,
      recentMessages: recent
        .filter((message) => message.mode === "persona")
        .map((message) => ({ role: message.role, content: message.content })),
      currentMessage: "[PROACTIVE_CONTACT]",
      currentBeijingTime: beijingTime(now),
      maxContextChars: 48_000,
    });
    prompt.messages[prompt.messages.length - 1] = {
      role: "system",
      content:
        "[PROACTIVE_CONTACT]\n只生成一次低频主动联系，在四类中选一类：询问最近学习和生活、延续旧话题、提一个轻松问题或观点、提醒休息或吃饭。不得虚构 Persona Bot 当天的经历、地点、行程或正在做的事；不催回复。不要输出（动作）（背景）等括号旁白或舞台说明，只输出主动联系要说的话。",
    };
    const response = await requestChat(
      deepSeekOptions(env, dependencies),
      prompt.messages,
    );
    await addDailyTokenUsage(
      env.DB,
      job.ownerId,
      utcDate(now),
      response.usage.inputTokens,
      response.usage.outputTokens,
    );
    const stored = await appendMessage(env.DB, {
      ownerId: job.ownerId,
      conversationId: conversation.conversationId,
      role: "assistant",
      mode: "persona",
      content: response.content,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      createdAt: job.scheduledAt,
    });
    assistant = {
      id: stored.messageId,
      conversation_id: stored.conversationId,
      content: stored.content,
    };
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
  }
}

export async function processQueueBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isQueueJob(message.body)) {
      message.ack();
      continue;
    }
    try {
      await processQueueMessage(message.body, env);
      message.ack();
    } catch (error) {
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

function isQueueJob(value: unknown): value is QueueJob {
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
    default:
      return false;
  }
}
