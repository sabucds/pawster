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
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          /**
           * The three secrets `web/wrangler.jsonc` deliberately does not carry, supplied
           * here as fixed values so the suite still needs no credentials — the same thing
           * `digest/`'s seam does for `UNSUBSCRIBE_SECRET`.
           *
           * Fixed rather than random, because a test that signs a cookie in one request and
           * verifies it in the next needs both to have happened under the same key. They are
           * obviously not secrets, which is the point: nothing real is reachable with them,
           * and the outbound interceptor means `RESEND_API_KEY` never leaves the isolate.
           */
          SESSION_SECRET: "test-session-secret-not-a-real-key",
          SIGN_IN_SECRET: "test-sign-in-secret-not-a-real-key",
          RESEND_API_KEY: "re_test_not_a_real_key",
          /**
           * Also supplied here, even though both are real `vars` in `web/wrangler.jsonc`.
           * The seam reads `dist/server/wrangler.json`, which `@astrojs/cloudflare`
           * generates, and depending on a generator to forward our `vars` would make the
           * suite fail on an adapter upgrade for a reason unrelated to anything under test.
           */
          SIGN_IN_FROM_ADDRESS: "entrar@pawster.test",
          SITE_ORIGIN: "https://pawster.test",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["../test/setup.ts", "./test/apply-migrations.ts"],
  },
});
