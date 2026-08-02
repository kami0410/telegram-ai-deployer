import { describe, expect, it } from "vitest";
import { renderRecoveryPage } from "../src/recovery-page";

describe("recovery setup page", () => {
  it("uses browser crypto and submits only the new hash", () => {
    const page = renderRecoveryPage({
      challengeId: "challenge-fixture-setup",
      purpose: "setup",
      nonce: "fixed-test-nonce",
    });

    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-fixed-test-nonce'",
    );
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.body).toContain("crypto.getRandomValues(new Uint8Array(10))");
    expect(page.body).toContain('fetch("/api/recovery/setup"');
    expect(page.body).toContain("newKeyHash");
    expect(page.body).not.toContain("Math.random");
    expect(page.body).not.toContain("https://cdn");
  });

  it("requires the old key only during recovery", () => {
    const page = renderRecoveryPage({
      challengeId: "challenge-fixture-recover",
      purpose: "recover",
      nonce: "fixed-test-nonce",
    });

    expect(page.body).toContain('id="old-key"');
    expect(page.body).toContain('fetch("/api/recovery/complete"');
    expect(page.body).toContain("oldKey");
    expect(page.body).toContain("迁移成功");
  });

  it("初次设置不误报为账号迁移", () => {
    const page = renderRecoveryPage({
      challengeId: "challenge-fixture-setup",
      purpose: "setup",
      nonce: "fixed-test-nonce",
    });

    expect(page.body).toContain("设置成功");
    expect(page.body).not.toContain("迁移成功");
  });

  it("escapes challenge data before embedding it in script", () => {
    const page = renderRecoveryPage({
      challengeId: '</script><script id="attack">alert(1)</script>',
      purpose: "setup",
      nonce: "fixed-test-nonce",
    });

    expect(page.body).not.toContain('<script id="attack">');
    expect(page.body).toContain("\\u003c/script\\u003e");
  });
});
