/**
 * The half of ADR 0010's pepper check that can happen at boot, and an honest note about the
 * half that cannot.
 *
 * ADR 0010: the pepper "must never rotate, and losing it fails open… every Do-Not-Contact
 * entry silently stops matching and the platform resumes mailing people who reported it as
 * spam, with no alarm anywhere. A fixed canary string is HMAC'd at boot and compared against a
 * stored constant so a wrong pepper fails loudly and immediately."
 *
 * ## Two failures, and only one of them is answerable without the database
 *
 * A **missing** pepper is a fact about configuration. It needs nothing but the environment, so
 * it is checked here, at module scope — which in a Worker is isolate startup, before the first
 * request is served. The Worker fails to boot, which is as loud as this gets and is what
 * "immediately" means.
 *
 * A **wrong** pepper can only be detected by HMAC'ing the canary and comparing it against the
 * row the platform stored under the original one, and **a Worker may not do I/O at module
 * scope** — there is no request to do it on behalf of, the same constraint `db/src/index.ts`
 * states about building a Drizzle client. So that half is `assertPepperUnchanged()`, called at
 * the top of every path that reads or writes `do_not_contact`: the signup form and the
 * delivery webhook. Between them they cover every route where a wrong pepper could do damage,
 * and the cost is one indexed point lookup.
 *
 * Writing it this way rather than claiming the whole check happens at boot is the point. The
 * ADR's sentence is about the failure being *loud rather than silent*, and it is: one half
 * refuses to start, the other throws on the first request that could act on a stale entry.
 */

import { env } from "cloudflare:workers";

/**
 * Why a blank pepper cannot be allowed to reach `sign()`.
 *
 * WebCrypto imports a zero-length HMAC key perfectly happily and produces stable digests from
 * it. So an unset secret does not fail — it produces a *second, consistent* keyspace, and every
 * Do-Not-Contact entry written under the real pepper stops matching while the platform carries
 * on looking like it is checking. That is exactly the silent open failure the ADR is about, and
 * it is why this is a presence check rather than a try/catch around the crypto.
 */
export function assertPepperPresent(pepper: string | undefined): void {
  if (pepper === undefined || pepper.trim() === "") {
    throw new Error(
      "DO_NOT_CONTACT_PEPPER is not set. It keys the Do-Not-Contact list, and an unset " +
        "pepper does not throw — WebCrypto signs happily with an empty key, so every entry " +
        "would silently stop matching and the platform would resume mailing people who " +
        "reported it as spam (ADR 0010). Set it with `wrangler secret put " +
        "DO_NOT_CONTACT_PEPPER` before serving a request.",
    );
  }
}

/**
 * Run at module evaluation, which is Worker startup.
 *
 * Guarded on `env` being populated at all, because this module is also evaluated by
 * `astro build` in Node, where `cloudflare:workers` supplies no bindings and there is no
 * secret to find. A build that threw here would fail for a reason that says nothing about the
 * deploy — and the deployed Worker still evaluates this module before its first request, which
 * is the moment that matters.
 */
if (env !== undefined && Object.keys(env).length > 0) {
  assertPepperPresent(env.DO_NOT_CONTACT_PEPPER);
}
