import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ReminderWorkflowPayload } from "./reminders";

function validPayload(value: ReminderWorkflowPayload): boolean {
  return (
    typeof value.reminderId === "string" &&
    /^[0-9a-f-]{36}$/u.test(value.reminderId) &&
    Number.isSafeInteger(value.ownerId) &&
    Number.isSafeInteger(value.dueAt)
  );
}

export class ReminderWorkflow extends WorkflowEntrypoint<Env, ReminderWorkflowPayload> {
  override async run(
    event: WorkflowEvent<ReminderWorkflowPayload>,
    step: WorkflowStep,
  ): Promise<{ queued: boolean }> {
    if (!validPayload(event.payload)) return { queued: false };
    await step.sleepUntil("等待提醒时间", event.payload.dueAt * 1_000);
    await step.do(
      "投递提醒",
      { retries: { limit: 8, delay: "10 seconds", backoff: "exponential" } },
      async () => {
        await this.env.MESSAGE_QUEUE.send({
          type: "reminder_delivery",
          reminderId: event.payload.reminderId,
          ownerId: event.payload.ownerId,
        });
      },
    );
    return { queued: true };
  }
}
