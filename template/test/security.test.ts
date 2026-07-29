import { describe, expect, it } from "vitest";
import {
  randomId,
  secureEqual,
  secureEqualHex,
  sha256Hex,
} from "../src/security";

describe("security primitives", () => {
  it("hashes UTF-8 input with SHA-256", async () => {
    expect(await sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("compares arbitrary secrets after fixed-size hashing", async () => {
    await expect(secureEqual("same-value", "same-value")).resolves.toBe(true);
    await expect(secureEqual("short", "a-much-longer-value")).resolves.toBe(
      false,
    );
  });

  it("compares valid SHA-256 hex values", () => {
    const hash = "a".repeat(64);
    expect(secureEqualHex(hash, hash)).toBe(true);
    expect(secureEqualHex(hash, `${"a".repeat(63)}b`)).toBe(false);
    expect(secureEqualHex("not-a-hash", hash)).toBe(false);
  });

  it("creates UUID identifiers with Web Crypto", () => {
    expect(randomId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
