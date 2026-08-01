import type { ChatCompletionMessage } from "./prompt";
import {
  canonicalPersonaJson,
  type PersonaSnapshot,
} from "./persona/seed";

const CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export interface DeepSeekOptions {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  thinking?: "enabled" | "disabled";
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetcher?: typeof fetch;
}

export interface DeepSeekUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface DeepSeekChatResult {
  content: string;
  usage: DeepSeekUsage;
}

export type DeepSeekErrorCode =
  | "rate_limited"
  | "upstream_4xx"
  | "upstream_5xx"
  | "timeout"
  | "network_error"
  | "invalid_response"
  | "response_too_large"
  | "invalid_memory_json"
  | "invalid_persona_draft";

export class DeepSeekError extends Error {
  readonly service = "deepseek";

  constructor(
    readonly code: DeepSeekErrorCode,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(`deepseek_${code}`);
    this.name = "DeepSeekError";
  }
}

interface CompletionEnvelope {
  choices: Array<{ message: { content: string } }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function parseCompletionEnvelope(value: unknown): CompletionEnvelope {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) {
    throw new DeepSeekError("invalid_response", 200, false);
  }
  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new DeepSeekError("invalid_response", 200, false);
  }
  const content = firstChoice.message.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new DeepSeekError("invalid_response", 200, false);
  }
  const usage = value.usage;
  if (
    !isRecord(usage) ||
    !isNonNegativeInteger(usage.prompt_tokens) ||
    !isNonNegativeInteger(usage.completion_tokens) ||
    !isNonNegativeInteger(usage.total_tokens)
  ) {
    throw new DeepSeekError("invalid_response", 200, false);
  }

  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new DeepSeekError("response_too_large", response.status, false);
  }
  if (response.body === null) {
    throw new DeepSeekError("invalid_response", response.status, false);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DeepSeekError("response_too_large", response.status, false);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requestCompletion(
  options: DeepSeekOptions,
  messages: ChatCompletionMessage[],
  responseFormat?: { type: "json_object" },
): Promise<DeepSeekChatResult> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        thinking: { type: options.thinking ?? "disabled" },
        stream: false,
        max_tokens: options.maxOutputTokens,
        ...(responseFormat === undefined
          ? {}
          : { response_format: responseFormat }),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
    });
  } catch (error) {
    if (error instanceof DeepSeekError) throw error;
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new DeepSeekError("timeout", null, true);
    }
    throw new DeepSeekError("network_error", null, true);
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new DeepSeekError("rate_limited", 429, true);
    }
    if (response.status >= 500) {
      throw new DeepSeekError("upstream_5xx", response.status, true);
    }
    throw new DeepSeekError("upstream_4xx", response.status, false);
  }

  const text = await readBoundedText(
    response,
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeepSeekError("invalid_response", response.status, false);
  }
  const envelope = parseCompletionEnvelope(parsed);
  return {
    content: envelope.choices[0]!.message.content,
    usage: {
      inputTokens: envelope.usage.prompt_tokens,
      outputTokens: envelope.usage.completion_tokens,
      totalTokens: envelope.usage.total_tokens,
    },
  };
}

async function requestCompletionWithInvalidResponseRetry(
  options: DeepSeekOptions,
  messages: ChatCompletionMessage[],
  responseFormat?: { type: "json_object" },
): Promise<DeepSeekChatResult> {
  try {
    return await requestCompletion(options, messages, responseFormat);
  } catch (error) {
    if (!(error instanceof DeepSeekError) || error.code !== "invalid_response") {
      throw error;
    }
    return requestCompletion(options, messages, responseFormat);
  }
}

export function requestChat(
  options: DeepSeekOptions,
  messages: ChatCompletionMessage[],
): Promise<DeepSeekChatResult> {
  return requestCompletionWithInvalidResponseRetry(options, messages);
}

export const MEMORY_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "routine",
  "wellbeing",
  "study",
  "interest",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryConfidence = "low" | "medium" | "high";

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (
    typeof value === "string" &&
    MEMORY_CATEGORIES.some((allowed) => allowed === value)
  );
}

export interface MemorySourceMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export interface ExtractedMemoryFact {
  category: MemoryCategory;
  factKey: string;
  factValue: string;
  confidence: MemoryConfidence;
  sourceMessageId: number;
}

export interface ExtractedMemoryEpisode {
  category: MemoryCategory;
  content: string;
  people: string[];
  topics: string[];
  occurredAt: number;
  sourceMessageId: number;
}

export type ExtractedRelationshipStateKind =
  | "open_thread"
  | "emotional_state"
  | "commitment"
  | "shared_moment"
  | "interaction_outcome";

export interface ExtractedRelationshipState {
  kind: ExtractedRelationshipStateKind;
  value: string;
  sourceMessageId: number;
}

export type ExtractedTimeMemoryLayerKind = "topic" | "week" | "month" | "relationship";

export interface ExtractedTimeMemoryLayer {
  layer: ExtractedTimeMemoryLayerKind;
  summary: string;
  topics: string[];
  importance: number;
}

export interface MemoryUpdateResult {
  summary: string;
  throughMessageId: number;
  stableFacts: ExtractedMemoryFact[];
  episodes: ExtractedMemoryEpisode[];
  relationshipStates: ExtractedRelationshipState[];
  timeLayers: ExtractedTimeMemoryLayer[];
  usage: DeepSeekUsage;
}

export interface MemoryUpdateInput {
  previousSummary: string | null;
  previousTimeLayers?: Array<{
    layer: ExtractedTimeMemoryLayerKind;
    periodKey: string;
    summary: string;
  }>;
  sourceMessages: MemorySourceMessage[];
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed)?.[1];
  if (fenced) {
    return fenced;
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  return firstBrace >= 0 && lastBrace > firstBrace
    ? trimmed.slice(firstBrace, lastBrace + 1)
    : trimmed;
}

function normalizeCategory(value: unknown): MemoryCategory {
  return isMemoryCategory(value) ? value : "interest";
}

function normalizeConfidence(value: unknown): MemoryConfidence {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function normalizeFactKey(value: unknown, sourceMessageId: number, index: number): string {
  const normalized = typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").replace(/^[_:-]+|[_:-]+$/g, "")
    : "";
  if (/^[a-z][a-z0-9_:-]{0,99}$/.test(normalized)) return normalized;
  return `memory_${sourceMessageId}_${index + 1}`;
}

function normalizeText(value: unknown, maximumLength: number): string {
  if (typeof value === "string") return value.trim().slice(0, maximumLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 10)
    .map((entry) => entry.slice(0, 100));
}

function normalizeImportance(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(5, Math.floor(value)))
    : 3;
}

function resolveUserSourceMessageId(
  sourceMessages: MemorySourceMessage[],
  claimedSourceId: unknown,
  evidence: unknown,
  extractedText: string,
): number | null {
  const userMessages = sourceMessages.filter((message) => message.role === "user");
  if (
    isNonNegativeInteger(claimedSourceId) &&
    userMessages.some((message) => message.id === claimedSourceId)
  ) {
    return claimedSourceId;
  }
  const fragments = [normalizeText(evidence, 1_000), extractedText]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index);
  for (const fragment of fragments) {
    const source = userMessages.find((message) => message.content.includes(fragment));
    if (source !== undefined) return source.id;
  }
  return null;
}

function parseMemoryUpdate(
  content: string,
  sourceMessages: MemorySourceMessage[],
): Omit<MemoryUpdateResult, "usage"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(content));
  } catch {
    throw new DeepSeekError("invalid_memory_json", 200, false);
  }
  if (!isRecord(parsed)) {
    throw new DeepSeekError("invalid_memory_json", 200, false);
  }
  const summary = parsed.summary;
  const lastMessageId = sourceMessages.at(-1)?.id;
  if (lastMessageId === undefined) {
    throw new DeepSeekError("invalid_memory_json", 200, false);
  }

  const facts = Array.isArray(parsed.stable_facts) ? parsed.stable_facts : [];
  const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
  const relationshipStates = Array.isArray(parsed.relationship_states)
    ? parsed.relationship_states
    : [];
  const timeLayers = isRecord(parsed.time_layers) ? parsed.time_layers : {};
  const normalizedFacts: ExtractedMemoryFact[] = facts
    .slice(0, 50)
    .flatMap((fact, index) => {
      if (!isRecord(fact)) return [];
      const factValue = normalizeText(fact.fact_value ?? fact.value ?? fact.content, 1_000);
      if (factValue.length === 0) return [];
      const sourceMessageId = resolveUserSourceMessageId(
        sourceMessages,
        fact.source_message_id,
        fact.evidence,
        factValue,
      );
      if (sourceMessageId === null) return [];
      return [{
        category: normalizeCategory(fact.category),
        factKey: normalizeFactKey(fact.fact_key ?? fact.key, sourceMessageId, index),
        factValue,
        confidence: normalizeConfidence(fact.confidence),
        sourceMessageId,
      }];
    });
  const normalizedEpisodes: ExtractedMemoryEpisode[] = episodes
    .slice(0, Math.max(0, 50 - normalizedFacts.length))
    .flatMap((episode) => {
      if (!isRecord(episode)) return [];
      const episodeContent = normalizeText(episode.content ?? episode.summary, 1_000);
      if (episodeContent.length === 0) return [];
      const sourceMessageId = resolveUserSourceMessageId(
        sourceMessages,
        episode.source_message_id,
        episode.evidence,
        episodeContent,
      );
      if (sourceMessageId === null) return [];
      return [{
        category: normalizeCategory(episode.category),
        content: episodeContent,
        people: normalizeLabels(episode.people),
        topics: normalizeLabels(episode.topics),
        occurredAt: isNonNegativeInteger(episode.occurred_at)
          ? episode.occurred_at
          : Math.floor(Date.now() / 1_000),
        sourceMessageId,
      }];
    });

  const allowedRelationshipKinds = new Set<ExtractedRelationshipStateKind>([
    "open_thread",
    "emotional_state",
    "commitment",
    "shared_moment",
    "interaction_outcome",
  ]);
  const normalizedRelationshipStates: ExtractedRelationshipState[] = relationshipStates
    .slice(0, 20)
    .flatMap((state) => {
      if (
        !isRecord(state) ||
        !allowedRelationshipKinds.has(state.kind as ExtractedRelationshipStateKind)
      ) return [];
      const value = normalizeText(state.value ?? state.content, 500);
      if (value.length === 0) return [];
      const sourceMessageId = resolveUserSourceMessageId(
        sourceMessages,
        state.source_message_id,
        state.evidence,
        value,
      );
      if (sourceMessageId === null) return [];
      return [{
        kind: state.kind as ExtractedRelationshipStateKind,
        value,
        sourceMessageId,
      }];
    });

  const normalizedTimeLayers: ExtractedTimeMemoryLayer[] = (
    ["topic", "week", "month", "relationship"] as const
  ).flatMap((layer) => {
    const value = timeLayers[layer];
    if (!isRecord(value)) return [];
    const summary = normalizeText(value.summary, 2_000);
    if (summary.length === 0) return [];
    return [{
      layer,
      summary,
      topics: normalizeLabels(value.topics),
      importance: normalizeImportance(value.importance),
    }];
  });

  return {
    summary: normalizeText(summary, 8_000),
    throughMessageId: lastMessageId,
    stableFacts: normalizedFacts,
    episodes: normalizedEpisodes,
    relationshipStates: normalizedRelationshipStates,
    timeLayers: normalizedTimeLayers,
  };
}

export async function requestMemoryUpdate(
  options: DeepSeekOptions,
  input: MemoryUpdateInput,
): Promise<MemoryUpdateResult> {
  if (input.sourceMessages.length === 0) {
    throw new DeepSeekError("invalid_memory_json", null, false);
  }
  const result = await requestCompletionWithInvalidResponseRetry(
    options,
    [
      {
        role: "system",
        content:
          "仅从用户明确说出的内容更新摘要和记忆，不得从助手回复推断。输出 JSON：summary、through_message_id、stable_facts、episodes、relationship_states、time_layers。stable_facts 只放长期稳定事实；短期情绪和一次性事件放 episodes；relationship_states 只放仍有后续价值的关系状态，kind 仅可为 open_thread、emotional_state、commitment、shared_moment、interaction_outcome，每项包含 kind、value、source_message_id、evidence。open_thread 仅用于用户明确提到、之后确实可能有结果或后续的考试、约定、等待结果、计划和未完成事项；普通闲聊、已经结束的事情、助手提出的问题不得标成 open_thread。time_layers 必须包含 topic、week、month、relationship 四个对象，每个对象只含 summary、topics、importance；在对应 previousTimeLayers 基础上压缩更新，topic 聚焦当前话题，week 聚焦本周，month 聚焦本月，relationship 只保留有明确用户证据的长期关系脉络。importance 为 1 至 5。所有新增信息必须来自本批用户消息；不得从助手话语、人格资料或推测创造共同经历、约定、感情结论或 Persona 的现实活动。",
      },
      {
        role: "user",
        content: JSON.stringify({
          previousSummary: input.previousSummary,
          previousTimeLayers: input.previousTimeLayers ?? [],
          allowedCategories: MEMORY_CATEGORIES,
          messages: input.sourceMessages,
        }),
      },
    ],
    { type: "json_object" },
  );
  return { ...parseMemoryUpdate(result.content, input.sourceMessages), usage: result.usage };
}

const PERSONA_ARRAY_PATHS = [
  "relationship.confidenceFacts",
  "relationship.rules",
  "relationship.meetingRules",
  "coreTraits.labels",
  "coreTraits.rules",
  "expression.markers",
  "expression.phraseEndings",
  "expression.rules",
  "expression.prohibited",
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
] as const;

type PersonaArrayPath = (typeof PERSONA_ARRAY_PATHS)[number];
type PersonaScalarPath = "comfort.opening";
export type PersonaDraftPath = PersonaArrayPath | PersonaScalarPath;

export interface PersonaDraftOperation {
  operation: "replace" | "add";
  path: PersonaDraftPath;
  value: string | string[];
}

export interface PersonaDraftProposal {
  summary: string;
  impactScope: string;
  confidence: MemoryConfidence;
  operations: PersonaDraftOperation[];
  usage: DeepSeekUsage;
}

export interface MaterializedPersonaPatch {
  path: PersonaDraftPath;
  value: string | string[];
}

function isPersonaArrayPath(value: unknown): value is PersonaArrayPath {
  return (
    typeof value === "string" &&
    PERSONA_ARRAY_PATHS.some((allowed) => allowed === value)
  );
}

function normalizeDraftText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizeAdditionText(value: string): string {
  const normalized = normalizeDraftText(value);
  const wrapped = normalized.match(/^<\s*(.*?)\s*>$/u);
  return wrapped?.[1]?.trim() || normalized;
}

function resolveAdditionPath(
  triggerText: string,
  selectedPath: PersonaArrayPath,
): PersonaArrayPath {
  const isDirective = /(?:不要|不再|减少|增加|必须|只能|仅|避免|禁止|频率|每次)/u.test(
    triggerText,
  );
  const controlsExpression = /(?:🌚|表情|emoji|语气|口头|回复|消息|对话|说|使用)/iu.test(
    triggerText,
  );
  return isDirective && controlsExpression ? "expression.rules" : selectedPath;
}

function invalidPersonaDraft(detail: string): never {
  throw new DeepSeekError("invalid_persona_draft", 200, false, detail);
}

function parsePersonaDraftProposal(
  content: string,
  triggerText: string,
  draftOperation: "correction" | "addition",
  usage: DeepSeekUsage,
): PersonaDraftProposal {
  let parsed: unknown;
  try {
    const normalizedContent = content
      .trim()
      .replace(/^```(?:json)?\s*/iu, "")
      .replace(/\s*```$/u, "");
    parsed = JSON.parse(normalizedContent);
  } catch {
    return invalidPersonaDraft("json_parse");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.operations)) {
    return invalidPersonaDraft("root_schema");
  }
  const rawSummary = parsed.summary;
  const rawImpactScope = parsed.impactScope ?? parsed.impact_scope;
  const confidence: MemoryConfidence =
    parsed.confidence === "low" ||
    parsed.confidence === "medium" ||
    parsed.confidence === "high"
      ? parsed.confidence
      : "medium";
  if (parsed.operations.length === 0 || parsed.operations.length > 16) {
    return invalidPersonaDraft("operation_count");
  }

  let operations: PersonaDraftOperation[] = parsed.operations.map((entry) => {
    if (!isRecord(entry)) return invalidPersonaDraft("operation_schema");
    const operation = entry.operation;
    const path = entry.path;
    const value = entry.value;
    const isArrayPath = isPersonaArrayPath(path);
    const isScalarPath = path === "comfort.opening";
    if (
      (operation !== "replace" && operation !== "add") ||
      (!isArrayPath && !isScalarPath) ||
      (isScalarPath && (operation !== "replace" || typeof value !== "string")) ||
      (isArrayPath &&
        !(
          typeof value === "string" ||
          (Array.isArray(value) && value.every((item) => typeof item === "string"))
        ))
    ) {
      return invalidPersonaDraft("operation_schema");
    }
    const normalizedValue =
      typeof value === "string"
        ? normalizeDraftText(value)
        : Array.isArray(value)
          ? value.map((item) =>
              typeof item === "string" ? normalizeDraftText(item) : "",
            )
          : invalidPersonaDraft("operation_schema");
    if (
      (typeof normalizedValue === "string" && normalizedValue.length === 0) ||
      (Array.isArray(normalizedValue) &&
        (normalizedValue.length === 0 ||
          normalizedValue.some((item) => item.length === 0 || item.length > 500)))
    ) {
      return invalidPersonaDraft("empty_or_oversize_value");
    }
    return { operation, path, value: normalizedValue };
  });

  const normalizedTrigger = normalizeAdditionText(triggerText);
  if (draftOperation === "addition") {
    const selected = operations[0];
    if (
      operations.length !== 1 ||
      selected?.operation !== "add" ||
      !isPersonaArrayPath(selected.path) ||
      normalizedTrigger.length === 0 ||
      normalizedTrigger.length > 500
    ) {
      return invalidPersonaDraft("addition_schema");
    }
    const resolvedPath = resolveAdditionPath(normalizedTrigger, selected.path);
    operations = [
      {
        operation: "add",
        path: resolvedPath,
        value: [normalizedTrigger],
      },
    ];
    return {
      summary: `新增到 ${resolvedPath}`,
      impactScope: resolvedPath,
      confidence,
      operations,
      usage,
    };
  }

  let summary =
    typeof rawSummary === "string"
      ? normalizeDraftText(rawSummary).slice(0, 300)
      : "";
  if (
    summary.length === 0 ||
    (normalizedTrigger.length >= 12 && summary.includes(normalizedTrigger))
  ) {
    summary = `调整 ${operations.map((operation) => operation.path).join("、")} 的人格规则`;
  }
  if (
    normalizedTrigger.length >= 12 &&
    JSON.stringify(operations).includes(normalizedTrigger)
  ) {
    return invalidPersonaDraft("copied_trigger");
  }
  let impactScope =
    typeof rawImpactScope === "string"
      ? normalizeDraftText(rawImpactScope).slice(0, 200)
      : "";
  if (
    normalizedTrigger.length >= 12 &&
    impactScope.includes(normalizedTrigger)
  ) {
    impactScope = operations.map((operation) => operation.path).join(", ");
  }
  if (impactScope.length === 0) {
    impactScope = operations.map((operation) => operation.path).join(", ");
  }
  return { summary, impactScope, confidence, operations, usage };
}

export async function requestPersonaDraft(
  options: DeepSeekOptions,
  input: {
    operation: "correction" | "addition";
    currentSnapshot: PersonaSnapshot;
    triggerText: string;
  },
): Promise<PersonaDraftProposal> {
  const request = async (strictRetry: boolean): Promise<DeepSeekChatResult> =>
    requestCompletionWithInvalidResponseRetry(
      { ...options, thinking: "enabled" },
      [
        {
          role: "system",
          content:
            input.operation === "addition"
              ? `${strictRetry ? "上一份草稿未通过验证。重新生成；" : ""}只输出 JSON：summary、impactScope、confidence、operations。你只负责为 correctionEvidence 选择一个最匹配的 allowedArrayPaths；operations 必须恰好一项，operation 必须是 add。不得推断、扩写、补充或拆分新事实；value 必须原样复制 correctionEvidence。带有“不要、减少、必须、仅在、频率”等约束的表达方式指令必须进入 expression.rules，expression.markers 只能存放模型可以直接说出的短词、笑声或表情。confidence 只能是 low、medium 或 high。`
              : `${strictRetry ? "上一份草稿未通过验证。重新生成；" : ""}只输出 JSON：summary、impactScope、confidence、operations；confidence 只能是 low、medium 或 high。每个 operation 只允许 operation=replace/add、显式允许的 path 和字符串或字符串数组 value。不得修改身份、同意、现实边界或安全规则；summary 和 operation.value 必须改写为简洁人格规则，不得整段复制用户原文。`,
        },
        {
          role: "user",
          content: JSON.stringify({
            operation: input.operation,
            allowedArrayPaths: PERSONA_ARRAY_PATHS,
            allowedScalarPaths: ["comfort.opening"],
            currentSnapshot:
              input.operation === "correction"
                ? JSON.parse(canonicalPersonaJson(input.currentSnapshot))
                : undefined,
            correctionEvidence: input.triggerText,
          }),
        },
      ],
      { type: "json_object" },
    );

  const first = await request(false);
  try {
    return parsePersonaDraftProposal(
      first.content,
      input.triggerText,
      input.operation,
      first.usage,
    );
  } catch (error) {
    if (
      !(error instanceof DeepSeekError) ||
      error.code !== "invalid_persona_draft"
    ) {
      throw error;
    }
  }

  const second = await request(true);
  const proposal = parsePersonaDraftProposal(
    second.content,
    input.triggerText,
    input.operation,
    second.usage,
  );
  return {
    ...proposal,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      totalTokens: first.usage.totalTokens + second.usage.totalTokens,
    },
  };
}

function currentArrayValue(
  snapshot: PersonaSnapshot,
  path: PersonaArrayPath,
): string[] {
  switch (path) {
    case "relationship.confidenceFacts":
      return snapshot.relationship.confidenceFacts;
    case "relationship.rules":
      return snapshot.relationship.rules;
    case "relationship.meetingRules":
      return snapshot.relationship.meetingRules;
    case "coreTraits.labels":
      return snapshot.coreTraits.labels;
    case "coreTraits.rules":
      return snapshot.coreTraits.rules;
    case "expression.markers":
      return snapshot.expression.markers;
    case "expression.phraseEndings":
      return snapshot.expression.phraseEndings;
    case "expression.rules":
      return snapshot.expression.rules;
    case "expression.prohibited":
      return snapshot.expression.prohibited;
    case "comfort.sequence":
      return snapshot.comfort.sequence;
    case "comfort.rules":
      return snapshot.comfort.rules;
    case "advice.rules":
      return snapshot.advice.rules;
    case "viewOfOwner.rules":
      return snapshot.viewOfOwner.rules;
    case "interests.topics":
      return snapshot.interests.topics;
    case "interests.publicFigures":
      return snapshot.interests.publicFigures;
    case "interests.rules":
      return snapshot.interests.rules;
    case "uncertainty.unknowns":
      return snapshot.uncertainty.unknowns;
    case "uncertainty.prohibitedInferences":
      return snapshot.uncertainty.prohibitedInferences;
    case "intimacy.rules":
      return snapshot.intimacy.rules;
    case "intimacy.prohibitedTerms":
      return snapshot.intimacy.prohibitedTerms;
    case "rhythm.rules":
      return snapshot.rhythm.rules;
    case "proactive.rules":
      return snapshot.proactive.rules;
    case "knowledge.rules":
      return snapshot.knowledge.rules;
  }
}

export function materializePersonaPatch(
  snapshot: PersonaSnapshot,
  operations: PersonaDraftOperation[],
): MaterializedPersonaPatch[] {
  return operations.map((operation) => {
    if (operation.path === "comfort.opening") {
      if (typeof operation.value !== "string" || operation.operation !== "replace") {
        return invalidPersonaDraft("materialization_schema");
      }
      return { path: operation.path, value: operation.value };
    }
    const incoming = Array.isArray(operation.value)
      ? operation.value
      : [operation.value];
    return {
      path: operation.path,
      value:
        operation.operation === "replace"
          ? incoming
          : [...new Set([...currentArrayValue(snapshot, operation.path), ...incoming])],
    };
  });
}
