import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

export * from "./retention.ts";
export * from "./schema.ts";

export type Database = ReturnType<typeof createDb>;

/**
 * Build a Drizzle client for this request.
 *
 * **Call this inside the request handler, never at module scope, and never cache the
 * result across requests** (ADR 0007).
 *
 * The reason is narrower than it looks, and the ADR originally gave a wrong one. Two
 * failures were predicted: the 1-second startup limit, which is a real deploy-time
 * rejection but says nothing about a client that is merely *built* early; and "Cannot
 * perform I/O on behalf of a different request" on the next request to touch a captured
 * binding. **The second was measured and does not happen.** On
 * `@cloudflare/vitest-plugin@1.1.4` a client built at module scope and one cached across
 * requests both return 200, every time — `db/test/module-scope-is-wrong.test.ts` asserts
 * that error's *absence* so the claim cannot quietly come back.
 *
 * What is actually wrong with module scope is simpler: it runs before there is a request,
 * and so before anything a request depends on exists. The fixture's third form shows it —
 * a query issued during module evaluation ran against a database whose migrations had not
 * been applied yet and failed with `no such table`.
 *
 * So nothing at runtime will catch you. Enforcement is structural instead:
 * `scripts/check-source-rules.mjs`, the first step of `npm test`.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}
