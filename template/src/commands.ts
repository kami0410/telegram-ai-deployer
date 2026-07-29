import type { OwnerRecord } from "./domain";
import { canonicalPersonaJson } from "./persona/seed";
import {
  closeActiveConversation,
  getOrCreateActiveConversation,
} from "./storage/chat-repository";
import {
  createSetupChallenge,
} from "./storage/recovery-repository";
import {
  confirmPersonaDraft,
  deletePersona,
  getCurrentPersona,
  rollbackPersona,
} from "./storage/persona-repository";
import { getDailyUsage } from "./storage/usage-repository";
import { queueMemoryVectorJob } from "./storage/semantic-memory-repository";
import { formatBeijingTime } from "./reminder-time";
import {
  cancelScheduledReminder,
  scheduleReminder,
  type ReminderWorkflowBinding,
} from "./reminders";
import { listPendingReminders } from "./storage/reminder-repository";

export const CONFIRM_FORGET_CURRENT = "确认忘记当前话题";
export const CONFIRM_FORGET_ALL = "确认删除全部聊天记忆";
export const CONFIRM_PERSONA_DELETE = "确认删除 Persona Bot 人格";
export const CONFIRM_PERSONA_CORRECTION = "确认修正";
export const CONFIRM_PERSONA_ADDITION = "确认新增";

const HELP_TEXT = `Persona Bot 命令帮助

日常聊天
/new — 开始新话题
/ask <问题> — 独立知识问答
/usage — 查看今日模型用量

记忆管理
/memory — 查看长期记忆
/forget — 删除当前话题及关联记忆
/forget all — 删除全部聊天与长期记忆

人格管理
/persona-add <事实> — 生成人格新增草稿
/persona-history — 查看人格版本历史
/persona-rollback <版本号> — 基于旧版本创建回滚版本
/persona-export — 导出当前人格
/persona-delete — 删除 Persona Bot 人格及版本

账号与面板
/settings — 打开管理面板
/recovery-key — 设置或轮换恢复钥匙
/recover — 在新 Telegram 账号发起迁移

删除、回滚等高影响操作会再次要求确认。`;

const CONFIRMATION_LIFETIME_SECONDS = 10 * 60;

export interface ParsedCommand {
  name: string;
  argument: string;
}

export interface OwnerCommandResult {
  handled: boolean;
  messages: string[];
  enqueue?: { mode: "ask" | "persona_addition"; content: string };
}

export interface OwnerCommandInput {
  db: D1Database;
  owner: OwnerRecord;
  text: string;
  now: number;
  recoveryBaseUrl: string;
  reminderWorkflow?: ReminderWorkflowBinding;
}

interface PendingConfirmationRow {
  command: "forget_current" | "forget_all" | "persona_delete";
}

interface MemoryListRow {
  category: string;
  fact_value: string;
  confidence: string;
}

interface PersonaEventRow {
  event_type: string;
  to_version: number;
  summary: string;
  created_at: number;
}

interface PersonaDraftRow {
  id: string;
  operation: "correction" | "addition";
  summary: string;
}

export function isPersonaCorrectionText(text: string): boolean {
  return /(?:她不会这样|Persona Bot\s*应该会|她应该会)/iu.test(text);
}

function utcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString().slice(0, 10);
}

export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(
    text.trim(),
  );
  if (match === null) return null;
  return {
    name: (match[1] ?? "").toLocaleLowerCase(),
    argument: (match[2] ?? "").trim(),
  };
}

async function setConfirmation(
  db: D1Database,
  ownerId: number,
  command: PendingConfirmationRow["command"],
  now: number,
): Promise<void> {
  const results = await db.batch([
    db.prepare("DELETE FROM pending_confirmations WHERE owner_id = ?").bind(ownerId),
    db
      .prepare(
        `INSERT INTO pending_confirmations (
           owner_id, command, payload_json, expires_at
         ) VALUES (?, ?, '{}', ?)`,
      )
      .bind(ownerId, command, now + CONFIRMATION_LIFETIME_SECONDS),
  ]);
  if (!results.every((result) => result.success)) {
    throw new Error("confirmation_create_failed");
  }
}

async function getPendingConfirmation(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<PendingConfirmationRow | null> {
  await db
    .prepare(
      "DELETE FROM pending_confirmations WHERE owner_id = ? AND expires_at < ?",
    )
    .bind(ownerId, now)
    .run();
  return db
    .prepare(
      `SELECT command FROM pending_confirmations
       WHERE owner_id = ? AND expires_at >= ?`,
    )
    .bind(ownerId, now)
    .first<PendingConfirmationRow>();
}

async function forgetCurrentConversation(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<void> {
  const current = await db
    .prepare(
      `SELECT id FROM conversations
       WHERE owner_id = ? AND status = 'active'`,
    )
    .bind(ownerId)
    .first<{ id: number }>();
  if (current === null) {
    await db
      .prepare("DELETE FROM pending_confirmations WHERE owner_id = ?")
      .bind(ownerId)
      .run();
    return;
  }

  const facts = await db.prepare(
    "SELECT id FROM memory_facts WHERE owner_id = ? AND source_conversation_id = ?",
  ).bind(ownerId, current.id).all<{ id: number }>();
  const episodes = await db.prepare(
    "SELECT id FROM memory_episodes WHERE owner_id = ? AND source_conversation_id = ?",
  ).bind(ownerId, current.id).all<{ id: number }>();
  for (const fact of facts.results) {
    await queueMemoryVectorJob(db, ownerId, "fact", fact.id, "delete", now);
  }
  for (const episode of episodes.results) {
    await queueMemoryVectorJob(db, ownerId, "episode", episode.id, "delete", now);
  }

  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM memory_facts
         WHERE owner_id = ? AND source_conversation_id = ?`,
      )
      .bind(ownerId, current.id),
    db
      .prepare(
        `DELETE FROM memory_episodes
         WHERE owner_id = ? AND source_conversation_id = ?`,
      )
      .bind(ownerId, current.id),
    db
      .prepare("DELETE FROM conversations WHERE id = ? AND owner_id = ?")
      .bind(current.id, ownerId),
    db
      .prepare("DELETE FROM pending_confirmations WHERE owner_id = ?")
      .bind(ownerId),
  ]);
  if (
    !results.every((result) => result.success) ||
    (results[2]?.meta.changes ?? 0) < 1
  ) {
    throw new Error("forget_current_failed");
  }
}

async function forgetAllChatData(
  db: D1Database,
  ownerId: number,
  now: number,
): Promise<void> {
  const facts = await db.prepare(
    "SELECT id FROM memory_facts WHERE owner_id = ?",
  ).bind(ownerId).all<{ id: number }>();
  const episodes = await db.prepare(
    "SELECT id FROM memory_episodes WHERE owner_id = ?",
  ).bind(ownerId).all<{ id: number }>();
  for (const fact of facts.results) {
    await queueMemoryVectorJob(db, ownerId, "fact", fact.id, "delete", now);
  }
  for (const episode of episodes.results) {
    await queueMemoryVectorJob(db, ownerId, "episode", episode.id, "delete", now);
  }
  const statements = [
    "DELETE FROM deliveries WHERE owner_id = ?",
    "DELETE FROM pending_confirmations WHERE owner_id = ?",
    "DELETE FROM processed_updates WHERE owner_id = ?",
    "DELETE FROM usage_daily WHERE owner_id = ?",
    "DELETE FROM memory_facts WHERE owner_id = ?",
    "DELETE FROM memory_episodes WHERE owner_id = ?",
    "DELETE FROM conversations WHERE owner_id = ?",
  ].map((sql) => db.prepare(sql).bind(ownerId));
  const results = await db.batch(statements);
  if (!results.every((result) => result.success)) {
    throw new Error("forget_all_failed");
  }
}

async function handleConfirmation(
  input: OwnerCommandInput,
): Promise<OwnerCommandResult | null> {
  const pending = await getPendingConfirmation(
    input.db,
    input.owner.ownerId,
    input.now,
  );
  if (pending === null) return null;

  if (
    pending.command === "forget_current" &&
    input.text === CONFIRM_FORGET_CURRENT
  ) {
    await forgetCurrentConversation(input.db, input.owner.ownerId, input.now);
    return { handled: true, messages: ["当前话题已删除。"] };
  }
  if (pending.command === "forget_all" && input.text === CONFIRM_FORGET_ALL) {
    await forgetAllChatData(input.db, input.owner.ownerId, input.now);
    return {
      handled: true,
      messages: ["全部聊天和长期聊天记忆已删除。"],
    };
  }
  if (
    pending.command === "persona_delete" &&
    input.text === CONFIRM_PERSONA_DELETE
  ) {
    const deleted = await deletePersona(input.db, input.owner.ownerId);
    await input.db
      .prepare("DELETE FROM pending_confirmations WHERE owner_id = ?")
      .bind(input.owner.ownerId)
      .run();
    return {
      handled: true,
      messages: [
        deleted
          ? "Persona Bot 人格及其版本已删除，聊天数据仍保留。"
          : "Persona Bot 人格已不存在，聊天数据仍保留。",
      ],
    };
  }
  return null;
}

async function handlePersonaVersionConfirmation(
  input: OwnerCommandInput,
): Promise<OwnerCommandResult | null> {
  const operation =
    input.text === CONFIRM_PERSONA_CORRECTION
      ? "correction"
      : input.text === CONFIRM_PERSONA_ADDITION
        ? "addition"
        : null;
  if (operation === null) return null;

  const draft = await input.db
    .prepare(
      `SELECT id, operation, summary FROM persona_change_drafts
       WHERE owner_id = ? AND operation = ? AND expires_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(input.owner.ownerId, operation, input.now)
    .first<PersonaDraftRow>();
  if (draft !== null) {
    const result = await confirmPersonaDraft(
      input.db,
      input.owner.ownerId,
      draft.id,
      input.now,
    );
    if (result.ok) {
      return {
        handled: true,
        messages: [
          `已创建 Persona Bot 人格 v${result.persona.version}：${draft.summary}`,
        ],
      };
    }
  }

  const latest = await input.db
    .prepare(
      `SELECT event_type, to_version, summary, created_at
       FROM persona_version_events
       WHERE owner_id = ? AND event_type = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(input.owner.ownerId, operation)
    .first<PersonaEventRow>();
  return {
    handled: true,
    messages: [
      latest === null
        ? `没有等待${operation === "correction" ? "修正" : "新增"}的人格草稿。`
        : `该变更已确认为 v${latest.to_version}，无需重复确认。`,
    ],
  };
}

function recoveryUrl(baseUrl: string, challengeId: string): string {
  const url = new URL("/recover", baseUrl);
  url.searchParams.set("challenge", challengeId);
  return url.toString();
}

export async function handleOwnerCommand(
  input: OwnerCommandInput,
): Promise<OwnerCommandResult> {
  const confirmation = await handleConfirmation(input);
  if (confirmation !== null) return confirmation;
  const personaConfirmation = await handlePersonaVersionConfirmation(input);
  if (personaConfirmation !== null) return personaConfirmation;

  const command = parseCommand(input.text);
  if (command === null) return { handled: false, messages: [] };

  switch (command.name) {
    case "help":
      return {
        handled: true,
        messages: [
          `${HELP_TEXT}\n\n提醒与回顾\n/remind <时间和内容> — 创建北京时间提醒\n/reminders — 查看待发送提醒\n/remind-cancel <编号> — 取消提醒\n每周日 21:00 自动发送最近七天聊天回顾`,
        ],
      };
    case "pair":
      return { handled: true, messages: ["这个机器人已经完成配对。"] };
    case "recover":
      return {
        handled: true,
        messages: ["请在新 Telegram 账号的机器人私聊中单独发送 /recover。"],
      };
    case "recovery-key": {
      const challenge = await createSetupChallenge(
        input.db,
        input.owner.telegramUserId,
        input.owner.telegramChatId,
        input.now,
      );
      if (!challenge.ok) {
        return { handled: true, messages: ["恢复钥匙设置链接生成失败。"] };
      }
      return {
        handled: true,
        messages: [
          `请在 10 分钟内用 HTTPS 页面设置新恢复钥匙：\n${recoveryUrl(input.recoveryBaseUrl, challenge.challengeId)}`,
        ],
      };
    }
    case "new": {
      await closeActiveConversation(input.db, input.owner.ownerId, input.now);
      await getOrCreateActiveConversation(input.db, input.owner.ownerId, input.now);
      return { handled: true, messages: ["新话题已开始。"] };
    }
    case "memory": {
      const facts = await input.db
        .prepare(
          `SELECT category, fact_value, confidence
           FROM memory_facts
           WHERE owner_id = ?
           ORDER BY updated_at DESC, id DESC
           LIMIT 20`,
        )
        .bind(input.owner.ownerId)
        .all<MemoryListRow>();
      if (facts.results.length === 0) {
        return { handled: true, messages: ["还没有积累长期聊天记忆。"] };
      }
      return {
        handled: true,
        messages: [
          facts.results
            .map(
              (fact) =>
                `· [${fact.category}/${fact.confidence}] ${fact.fact_value}`,
            )
            .join("\n"),
        ],
      };
    }
    case "usage": {
      const usage = await getDailyUsage(
        input.db,
        input.owner.ownerId,
        utcDate(input.now),
      );
      return {
        handled: true,
        messages: [
          `今日请求 ${usage.requestCount} 次，输入 ${usage.inputTokens} tokens，输出 ${usage.outputTokens} tokens。`,
        ],
      };
    }
    case "remind": {
      if (command.argument.length === 0 || input.reminderWorkflow === undefined) {
        return {
          handled: true,
          messages: ["用法：/remind 明晚八点提醒我复习\n也可用：/remind 2026-08-02 09:30 交作业"],
        };
      }
      const reminder = await scheduleReminder(input.db, input.reminderWorkflow, {
        ownerId: input.owner.ownerId,
        request: command.argument,
        now: input.now,
      });
      return reminder === null
        ? {
            handled: true,
            messages: ["我没看懂具体时间或提醒内容。可以这样发：/remind 明晚八点提醒我复习"],
          }
        : {
            handled: true,
            messages: [`记住了。${formatBeijingTime(reminder.dueAt)}（北京时间）提醒你：${reminder.content}\n编号：${reminder.code}`],
          };
    }
    case "reminders": {
      const reminders = await listPendingReminders(input.db, input.owner.ownerId, 20);
      return {
        handled: true,
        messages: [
          reminders.length === 0
            ? "现在没有待发送的提醒。"
            : reminders.map((reminder) =>
                `${reminder.code}｜${formatBeijingTime(reminder.dueAt)}｜${reminder.content}`,
              ).join("\n"),
        ],
      };
    }
    case "remind-cancel": {
      if (!/^[a-z0-9]{8}$/u.test(command.argument) || input.reminderWorkflow === undefined) {
        return { handled: true, messages: ["用法：/remind-cancel <8位提醒编号>"] };
      }
      const result = await cancelScheduledReminder(
        input.db,
        input.reminderWorkflow,
        input.owner.ownerId,
        command.argument,
        input.now,
      );
      return {
        handled: true,
        messages: [
          result === "cancelled"
            ? "提醒已取消。"
            : result === "too_late"
              ? "这个提醒已经开始发送，来不及取消了。"
            : result === "already_done"
              ? "这个提醒已经发送或取消了。"
              : "没有找到这个提醒。",
        ],
      };
    }
    case "ask":
      return command.argument.length === 0
        ? { handled: true, messages: ["用法：/ask <问题>"] }
        : {
            handled: true,
            messages: [],
            enqueue: { mode: "ask", content: command.argument },
          };
    case "persona-add":
      return command.argument.length === 0
        ? { handled: true, messages: ["用法：/persona-add <Persona Bot 后来明确表达的新事实>"] }
        : {
            handled: true,
            messages: [],
            enqueue: { mode: "persona_addition", content: command.argument },
          };
    case "persona-history": {
      const events = await input.db
        .prepare(
          `SELECT event_type, to_version, summary, created_at
           FROM persona_version_events
           WHERE owner_id = ?
           ORDER BY id DESC
           LIMIT 20`,
        )
        .bind(input.owner.ownerId)
        .all<PersonaEventRow>();
      return {
        handled: true,
        messages: [
          events.results.length === 0
            ? "没有 Persona Bot 人格版本。"
            : events.results
                .map(
                  (event) =>
                    `v${event.to_version} ${event.event_type}：${event.summary}`,
                )
                .join("\n"),
        ],
      };
    }
    case "persona-rollback": {
      const targetVersion = Number(command.argument);
      if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
        return {
          handled: true,
          messages: ["用法：/persona-rollback <版本号>"],
        };
      }
      const result = await rollbackPersona(
        input.db,
        input.owner.ownerId,
        targetVersion,
        `回滚到 v${targetVersion}`,
        input.now,
      );
      return {
        handled: true,
        messages: [
          result.ok
            ? `已创建回滚版本 v${result.persona.version}。`
            : "指定的人格版本不存在。",
        ],
      };
    }
    case "persona-export": {
      const persona = await getCurrentPersona(input.db, input.owner.ownerId);
      return {
        handled: true,
        messages:
          persona === null
            ? ["没有 Persona Bot 人格可导出。"]
            : [
                `Persona Bot persona v${persona.version}\n${canonicalPersonaJson(persona.snapshot)}`,
              ],
      };
    }
    case "forget":
      if (command.argument.toLocaleLowerCase() === "all") {
        await setConfirmation(
          input.db,
          input.owner.ownerId,
          "forget_all",
          input.now,
        );
        return {
          handled: true,
          messages: [
            `这会删除全部聊天、摘要、长期聊天记忆和用量记录，但保留账号、恢复钥匙和 Persona Bot 人格。请发送“${CONFIRM_FORGET_ALL}”确认。`,
          ],
        };
      }
      if (command.argument.length > 0) {
        return { handled: true, messages: ["用法：/forget 或 /forget all"] };
      }
      await setConfirmation(
        input.db,
        input.owner.ownerId,
        "forget_current",
        input.now,
      );
      return {
        handled: true,
        messages: [
          `这只会删除当前话题的完整消息、摘要和仅来源于它的长期事实。请发送“${CONFIRM_FORGET_CURRENT}”确认。`,
        ],
      };
    case "persona-delete":
      await setConfirmation(
        input.db,
        input.owner.ownerId,
        "persona_delete",
        input.now,
      );
      return {
        handled: true,
        messages: [
          `这会删除 Persona Bot 人格、所有版本和主动联系状态，但不会删除聊天或长期聊天记忆。请发送“${CONFIRM_PERSONA_DELETE}”确认。`,
        ],
      };
    default:
      return { handled: true, messages: ["不认识这个命令。"] };
  }
}
