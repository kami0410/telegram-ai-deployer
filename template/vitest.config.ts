import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.resolve("migrations"));

      return {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TELEGRAM_BOT_TOKEN: "test-only-telegram-token",
            DEEPSEEK_API_KEY: "test-only-deepseek-key",
            TELEGRAM_WEBHOOK_SECRET: "test-only-webhook-secret",
            OWNER_PAIRING_CODE: "test-only-pairing-code",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
