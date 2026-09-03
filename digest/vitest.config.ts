import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * The migrations are read on the Node side at config time and handed to the isolate as a
 * binding, because `applyD1Migrations` runs inside the Worker where there is no file
 * system. These are the same files `wrangler d1 migrations apply` would run in
 * production — the test seam applies the real migrations, not a hand-written schema that
 * can drift away from them.
 */
const migrations = await readD1Migrations("../db/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          // A secret in production; a fixed string here. The suite runs with no
          // Cloudflare account and no credentials, so nothing real may be required.
          RESEND_API_KEY: "re_test_key",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["../test/setup.ts", "./test/apply-migrations.ts"],
  },
});
