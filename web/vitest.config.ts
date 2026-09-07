import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("../db/migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      /**
       * The *built* Worker, not the source. `@astrojs/cloudflare` resolves `main`, the
       * `ASSETS` binding and the assets directory itself and writes the result here, so
       * this is the only config that describes a deployable `web/`. It is also why
       * `npm test` in this package builds first: the prerendered page has to exist on
       * disk before a test can ask for it.
       */
      wrangler: { configPath: "./dist/server/wrangler.json" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["../test/setup.ts", "./test/apply-migrations.ts"],
  },
});
