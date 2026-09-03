import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export * from "./schema.ts";

export type Database = ReturnType<typeof createDb>;

/**
 * Build a Drizzle client for this request.
 *
 * **Call this inside the request handler, never at module scope, and never cache the
 * result across requests.** Two separate failures punish a module-scope client: the
 * 1-second startup limit is a deploy-time rejection, and a binding captured in one
 * request's I/O context throws "Cannot perform I/O on behalf of a different request" when
 * the next request touches it. The second is the nastier one, because it survives every
 * single-request test and only appears once an isolate serves a second request.
 *
 * `db/src/module-scope-is-wrong.test.ts` demonstrates both halves against a real Worker
 * rather than asserting them, and `db/src/no-module-scope-client.test.ts` keeps the
 * codebase from drifting back.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
