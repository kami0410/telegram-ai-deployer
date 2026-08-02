import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves a public privacy-safe status homepage", async () => {
  const response = await SELF.fetch("https://example.test/");
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(html).toContain("Persona 在线");
  expect(html).toContain("DeepSeek Flash");
  expect(html).toContain("长期记忆与语义检索");
  expect(html).toContain("隐私优先");
  expect(html).toContain('href="/app"');
  expect(html).not.toContain("记忆数量");
  expect(html).not.toContain("Telegram ID");
  expect(html).not.toContain("database_id");
});
