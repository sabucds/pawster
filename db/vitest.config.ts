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
    // The interceptor goes into *every* project, this one included. `db/` makes no
    // outbound calls, which is the point: if it ever starts, the dispatcher records the
    // escape and `assertNoViolations` fails the run rather than letting it out.
    setupFiles: ["../test/setup.ts", "./test/apply-migrations.ts"],
  },
});
