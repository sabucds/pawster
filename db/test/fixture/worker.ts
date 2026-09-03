import { env as moduleScopeEnv } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { createDb, shelters } from "../../src/index.ts";
import * as schema from "../../src/schema.ts";

/**
 * A deliberately wrong Worker, kept so the module-scope rule has a demonstration rather
 * than an assertion. Nothing outside this directory may look like the first two routes,
 * and `db/test/no-module-scope-client.test.ts` is what keeps it that way.
 */

/**
 * Wrong, form one: built while the module is evaluated, before any request exists. This is
 * literally "a Drizzle client constructed at module scope".
 */
const moduleScopeDb = drizzle(moduleScopeEnv.DB, { schema });

/**
 * Wrong, form two: built inside the first request and kept. Subtler than form one and more
 * common, because it looks like a cache. The client outlives the I/O context of the
 * request that produced it.
 */
let cachedDb: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * Wrong, form three: not just *building* the client at module scope but *using* it there.
 * Started without `await` so a rejection does not stop the module from evaluating — the
 * point is to capture what the runtime says, not to break the fixture's boot.
 */
const moduleScopeQuery: Promise<string | null> = moduleScopeDb
  .select()
  .from(shelters)
  .then(
    () => null,
    // Drizzle wraps the driver's error, so the runtime's own message — the interesting
    // half — is on `cause`.
    (error: unknown) => String((error as { cause?: unknown })?.cause ?? error),
  );

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/module-scope") {
      const rows = await moduleScopeDb.select().from(shelters);
      return Response.json({ count: rows.length });
    }

    if (pathname === "/cached-across-requests") {
      cachedDb ??= drizzle(env.DB, { schema });
      const rows = await cachedDb.select().from(shelters);
      return Response.json({ count: rows.length });
    }

    if (pathname === "/module-scope-io") {
      const error = await moduleScopeQuery;
      return Response.json({ error });
    }

    if (pathname === "/per-request") {
      // The rule: construct inside the handler, every time, and never keep it.
      const db = createDb(env.DB);
      const rows = await db.select().from(shelters);
      return Response.json({ count: rows.length });
    }

    return new Response("not found", { status: 404 });
  },
};
