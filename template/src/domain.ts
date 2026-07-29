export interface OwnerRecord {
  ownerId: number;
  telegramUserId: number;
  telegramChatId: number;
  pairedAt: number;
  migratedAt: number | null;
}

export type UpdateStatus =
  | "received"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type UpdateClaim = "new" | "requeue" | "duplicate";
