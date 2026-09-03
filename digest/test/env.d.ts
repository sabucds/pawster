import type { D1Migration } from "@cloudflare/vitest-plugin";

/**
 * Bindings that exist only under test, plus the secrets Wrangler cannot see from
 * `wrangler.jsonc`. `worker-configuration.d.ts` is generated from the Wrangler config and
 * must not be hand-edited, so the additions live here.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      /** A secret in production; a fixed string in `vitest.config.ts`. */
      RESEND_API_KEY: string;
      /**
       * The real `db/migrations` files, read on the Node side at config time and handed
       * in as a binding because `applyD1Migrations` runs inside the Worker, where there
       * is no file system.
       */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
