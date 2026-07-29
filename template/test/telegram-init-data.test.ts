import { describe, expect, it } from "vitest";
import { verifyTelegramInitData } from "../src/telegram-init-data";

const TOKEN = "123456:test-token";
const NOW = 1_800_000_000;

async function hmac(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function signedInitData(overrides: Record<string, string> = {}): Promise<string> {
  const fields = new Map<string, string>([
    ["auth_date", String(NOW - 30)],
    ["query_id", "AAExample"],
    ["user", JSON.stringify({ id: 101, first_name: "OWNER" })],
    ...Object.entries(overrides),
  ]);
  const dataCheck = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  const signature = new Uint8Array(await hmac(secret, dataCheck));
  fields.set("hash", [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  return new URLSearchParams(fields).toString();
}

describe("Telegram Mini App initData", () => {
  it("accepts a valid signed private identity", async () => {
    await expect(verifyTelegramInitData(await signedInitData(), TOKEN, NOW))
      .resolves.toEqual({ userId: 101, chatId: 101, authDate: NOW - 30 });
  });

  it("uses a signed chat id when Telegram supplies one", async () => {
    const value = await signedInitData({
      chat: JSON.stringify({ id: 201, type: "private", title: "OWNER" }),
    });
    await expect(verifyTelegramInitData(value, TOKEN, NOW))
      .resolves.toMatchObject({ userId: 101, chatId: 201 });
  });

  it("rejects tampering, expiry, missing user, and non-private chats", async () => {
    const valid = await signedInitData();
    const tampered = valid.replace("OWNER", "OTHER");
    await expect(verifyTelegramInitData(tampered, TOKEN, NOW)).rejects.toThrow("init_data_signature_invalid");
    await expect(verifyTelegramInitData(
      await signedInitData({ auth_date: String(NOW - 901) }), TOKEN, NOW,
    )).rejects.toThrow("init_data_expired");
    const missingUser = await signedInitData({ user: "null" });
    await expect(verifyTelegramInitData(missingUser, TOKEN, NOW)).rejects.toThrow("init_data_user_invalid");
    const group = await signedInitData({ chat: JSON.stringify({ id: -1, type: "group" }) });
    await expect(verifyTelegramInitData(group, TOKEN, NOW)).rejects.toThrow("init_data_chat_invalid");
  });
});
