import { env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * ADR 0007 says the Drizzle client is constructed inside the request handler and never at
 * module scope. This file runs the wrong versions against a real D1 binding and records
 * what the runtime actually does with each — because the answer is not what the ADR
 * predicts, and a rule everyone believes is enforced but is not is worse than a rule
 * everyone knows they have to keep themselves.
 *
 * **The finding: no test in this suite can catch a module-scope client.** Two of the three
 * wrong forms below pass silently. ADR 0007 says a module-scope client "also triggers
 * 'Cannot perform I/O on behalf of a different request'"; that error was never produced
 * here, at any of the three, on `@cloudflare/vitest-plugin@1.1.4`. Nor can the 1-second
 * startup limit be observed, being a deploy-time rejection. Enforcement is therefore
 * structural — `scripts/check-source-rules.mjs`, run by `npm test` — and these tests exist
 * to keep the gap visible and versioned: if a future runtime starts enforcing the rule,
 * they fail, and that failure is the good news that the guard can be retired.
 *
 * See `docs/testing-seams.md`.
 */

const fixture = workerExports.default as unknown as Fetcher;

const get = (path: string) => fixture.fetch(`https://fixture${path}`);

describe("what the local runtime does with a module-scope client", () => {
  it("does not reject building one at module scope", async () => {
    // Construction is not I/O — it wraps a binding and returns. Nothing complains.
    expect((await get("/module-scope")).status).toBe(200);
  });

  it("does not reject one cached across requests either", async () => {
    await get("/cached-across-requests");
    const second = await get("/cached-across-requests");

    expect(second.status).toBe(200);
    // The failure ADR 0007 predicts, asserted by its absence so the ADR's claim and this
    // suite's reality cannot silently drift apart.
    expect(await second.text()).not.toMatch(
      /Cannot perform I\/O on behalf of a different request/,
    );
  });

  it("lets a module-scope query run, but at isolate startup — a different world", async () => {
    // The one observable difference, and it is observable only because it is severe: this
    // query ran while the module was being evaluated, before `beforeAll` applied the
    // migrations, so it saw a database with no tables in it. The same query inside the
    // handler succeeds. Module scope is not "earlier in the request"; it is before there
    // is a request, and before anything a request depends on has been set up.
    const response = await get("/module-scope-io");

    expect(await response.json()).toEqual({
      error: "Error: D1_ERROR: no such table: shelters: SQLITE_ERROR",
    });
  });
});

describe("a Drizzle client constructed inside the handler", () => {
  it("works on every request, which is the whole difference", async () => {
    for (let i = 0; i < 3; i++) {
      const response = await get("/per-request");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ count: 0 });
    }
  });

  it("reads the real schema the real migrations created", async () => {
    await env.DB.prepare(
      "INSERT INTO shelters (id, display_name, account_email, country_code, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("s1", "Refugio Ejemplo", "hola@example.org", "VE", 0)
      .run();

    const response = await get("/per-request");
    expect(await response.json()).toEqual({ count: 1 });

    await env.DB.exec("DELETE FROM shelters");
  });
});
