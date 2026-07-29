import { describe, expect, it } from "vitest";
import {
  encodeRecoveryKey,
  hashRecoveryKey,
  isRecoveryKey,
  normalizeRecoveryKey,
} from "../src/recovery-key";

describe("short recovery keys", () => {
  it("encodes exactly 80 random bits into 16 Crockford characters", () => {
    expect(encodeRecoveryKey(new Uint8Array(10))).toBe(
      "YR-0000-0000-0000-0000",
    );
    expect(encodeRecoveryKey(new Uint8Array(10).fill(255))).toBe(
      "YR-ZZZZ-ZZZZ-ZZZZ-ZZZZ",
    );
    expect(() => encodeRecoveryKey(new Uint8Array(9))).toThrow(
      "recovery_key_requires_10_bytes",
    );
  });

  it("normalizes case, grouping hyphens, and spaces", () => {
    expect(normalizeRecoveryKey(" yr abcd efgh jkmt npqr ")).toBe(
      "YR-ABCD-EFGH-JKMT-NPQR",
    );
    expect(normalizeRecoveryKey("yr-abcd-efgh-jkmt-npqr")).toBe(
      "YR-ABCD-EFGH-JKMT-NPQR",
    );
  });

  it("rejects ambiguous and incorrectly sized keys", () => {
    expect(normalizeRecoveryKey("YR-ABCI-EFGH-JKMT-NPQR")).toBeNull();
    expect(normalizeRecoveryKey("YR-ABCO-EFGH-JKMT-NPQR")).toBeNull();
    expect(normalizeRecoveryKey("YR-ABCD-EFGH-JKMT-NPQ")).toBeNull();
    expect(isRecoveryKey("YR-ABCD-EFGH-JKMT-NPQR")).toBe(true);
    expect(isRecoveryKey("not-a-key")).toBe(false);
  });

  it("hashes the canonical key representation", async () => {
    const canonical = "YR-ABCD-EFGH-JKMT-NPQR";
    await expect(hashRecoveryKey(canonical)).resolves.toBe(
      await hashRecoveryKey("yr abcd efgh jkmt npqr"),
    );
    await expect(hashRecoveryKey("bad-key")).resolves.toBeNull();
  });
});
