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
    }
  }
}

export {};
