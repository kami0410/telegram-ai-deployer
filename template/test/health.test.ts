import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("returns only the safe health payload", async () => {
  const response = await SELF.fetch("https://example.test/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    service: "persona-telegram-bot",
  });
});

it("does not expose unknown routes", async () => {
  const response = await SELF.fetch("https://example.test/unknown");

  expect(response.status).toBe(404);
});
