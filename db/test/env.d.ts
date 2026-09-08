import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      /**
       * The real `db/migrations` files, read on the Node side at config time and handed in
       * as a binding because `applyD1Migrations` runs inside the Worker, where there is no
       * file system.
       */
      TEST_MIGRATIONS: D1Migration[];
      /**
       * The unmigrated second database `migrations.test.ts` owns. Declared here because the
       * binding is real — it is in `test/fixture/wrangler.jsonc` — but `Cloudflare.Env` for
       * this project is not generated from that file.
       */
      MIGRATION_DB: D1Database;
    }
  }
}

export {};
