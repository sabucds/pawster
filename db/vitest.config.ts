import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // A fixture Worker, not a real one. `db/` ships no Worker; it needs an isolate only
      // so the module-scope rule can be demonstrated against a real D1 binding.
      wrangler: { configPath: "./test/fixture/wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
