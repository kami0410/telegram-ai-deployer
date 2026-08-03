import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves a public privacy-safe status homepage", async () => {
  const response = await SELF.fetch("https://example.test/");
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(html).toContain("Persona 在线");
  expect(html).toContain(env.DEEPSEEK_MODEL.includes("pro") ? "DeepSeek Pro" : "DeepSeek Flash");
  expect(html).toContain("长期记忆与语义检索");
  expect(html).toContain("隐私与数据");
  expect(html).toContain("当前状态");
  expect(html).toContain("开始使用");
  expect(html).toContain("命令速查");
  expect(html).toContain("工作方式");
  expect(html).toContain("主动联系");
  expect(html).toContain("常见问题");
  expect(html).toContain("Cloudflare Workers");
  expect(html).toContain("在 Telegram 中打开管理面板");
  expect(html).toContain("meta http-equiv=\"refresh\"");
  expect(html).toContain("rel=\"icon\"");
  expect(html).toContain("href=\"/app\"");
  expect(html).not.toContain("记忆数量");
  expect(html).not.toContain("Telegram ID");
  expect(html).not.toContain("database_id");
  expect(html).not.toContain("memory_facts");
});
