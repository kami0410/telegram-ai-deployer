import { parseReminderRequest } from "./reminder-time";
import {
  cancelReminder,
  createReminder,
  getReminderByCode,
  setReminderWorkflowInstance,
  type ReminderRecord,
} from "./storage/reminder-repository";

export interface ReminderWorkflowInstance {
  id: string;
  terminate(): Promise<void>;
}

export interface ReminderWorkflowBinding {
  create(options: {
    id: string;
    params: ReminderWorkflowPayload;
    retention?: {
      successRetention?: WorkflowSleepDuration;
      errorRetention?: WorkflowSleepDuration;
    };
  }): Promise<ReminderWorkflowInstance>;
  get(id: string): Promise<ReminderWorkflowInstance>;
}

export interface ReminderWorkflowPayload {
  reminderId: string;
  ownerId: number;
  dueAt: number;
}

export async function scheduleReminder(
  db: D1Database,
  workflow: ReminderWorkflowBinding,
  input: { ownerId: number; request: string; now: number },
): Promise<ReminderRecord | null> {
  const parsed = parseReminderRequest(input.request, input.now);
  if (parsed === null) return null;
  const reminder = await createReminder(db, {
    ownerId: input.ownerId,
    content: parsed.content,
    dueAt: parsed.dueAt,
    now: input.now,
  });
  try {
    const instance = await workflow.create({
      id: `reminder-${reminder.id}`,
      params: {
        reminderId: reminder.id,
        ownerId: input.ownerId,
        dueAt: reminder.dueAt,
      },
      retention: { successRetention: "1 hour", errorRetention: "1 day" },
    });
    await setReminderWorkflowInstance(
      db,
      reminder.id,
      input.ownerId,
      instance.id,
      input.now,
    );
    return { ...reminder, workflowInstanceId: instance.id };
  } catch (error) {
    await db.prepare(
      `UPDATE reminders SET status = 'failed', last_error = ?, updated_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'pending'`,
    ).bind(
      error instanceof Error ? error.message.slice(0, 200) : "workflow_create_failed",
      input.now,
      reminder.id,
      input.ownerId,
    ).run();
    throw error;
  }
}

export async function cancelScheduledReminder(
  db: D1Database,
  workflow: ReminderWorkflowBinding,
  ownerId: number,
  code: string,
  now: number,
): Promise<"cancelled" | "too_late" | "already_done" | "not_found"> {
  const reminder = await getReminderByCode(db, ownerId, code);
  const result = await cancelReminder(db, ownerId, code, now);
  if (result !== "cancelled" || reminder?.workflowInstanceId === null || reminder === null) {
    return result;
  }
  try {
    const instance = await workflow.get(reminder.workflowInstanceId);
    await instance.terminate();
  } catch {
    // D1 cancellation is authoritative; an awakened Workflow will re-check it.
  }
  return result;
}
