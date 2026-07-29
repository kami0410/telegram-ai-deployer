import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("management Mini App page", () => {
  it("serves secure no-store HTML with all management sections", async () => {
    const response = await SELF.fetch("https://example.test/app");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(html).toContain("Persona Bot 管理面板");
    expect(html).toContain('data-view="overview"');
    expect(html).toContain('data-view="memories"');
    expect(html).toContain('data-view="persona"');
    expect(html).toContain('data-view="drafts"');
    expect(html).not.toContain("localStorage");
  });

  it("serves same-origin application code without caching", async () => {
    const response = await SELF.fetch("https://example.test/app.js");
    const script = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(script).toContain("Telegram.WebApp.initData");
    expect(script).toContain("telegram-init-data");
    expect(script).toContain("memory-conflict=");
    expect(script).toContain("/api/app/memory-conflicts/");
    expect(script).not.toContain("localStorage");
  });
});
