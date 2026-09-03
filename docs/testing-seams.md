# The two test seams

Pawster's suite runs against real infrastructure with **no network and no credentials**:
a real `workerd` isolate, a real local D1 with the real migrations applied, real Queues
semantics. Nothing outside Cloudflare is reachable, and the one place the platform talks
to the outside world is replaced by a single interceptor.

```sh
npm test              # every workspace, plus the structural source rules
npm run typecheck     # every workspace
```

Verified offline on 2026-09-03: the whole suite passes with `HTTPS_PROXY` pointed at a
dead port and `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CF_API_TOKEN` unset.

## Seam one: the Worker under test

Both Workers are exercised through their own front door rather than by calling exported
handlers, so the asset router, the bindings and the Queues machinery are all in the
picture.

| What | How |
|---|---|
| A prerendered page | `SELF.fetch("/")` — answered by Static Assets, no Worker invocation |
| An SSR route reading D1 | `SELF.fetch("/animales/:id")` — Drizzle client built in the handler |
| A `scheduled()` run | `exports.default.scheduled({ scheduledTime })` |
| A queue batch | `worker.queue(batch, env, ctx)`, then `getQueueResult(batch, ctx)` |

Migrations come from `db/migrations` — the same files `wrangler d1 migrations apply` runs
in production. They are read on the Node side in each `vitest.config.ts` and passed into
the isolate as a binding, because `applyD1Migrations` runs inside the Worker, where there
is no file system.

### How we know the prerendered page costs no Worker invocation

`/` is prerendered, so Astro's server bundle carries no route for it, and
`@astrojs/cloudflare`'s server entrypoint never references the `ASSETS` binding — grep it.
If the request had reached the Worker there would be nothing there to answer it. It
returns the page, so the asset router answered ahead of the Worker. That is what ADR 0007
is buying: no invocation, no CPU, and no count against the 100,000 requests/day cap.

## Seam two: the outbound interceptor

`test/outbound.ts`. **One dispatcher, not one fake per vendor.** Everything Pawster sends
outward — Resend, Healthchecks.io, and the `cf.image` transform pipeline — leaves through
`globalThis.fetch`, so replacing that one function sees all of it and lands it in one
ordered call log. This is what lets "exactly one email per recipient under idempotency key
X" be a single assertion against a single list rather than a question asked of three
mocks that each know only their own half.

It works because the Vitest plugin runs the Worker in the same isolate as the test file,
so a global mock installed by a test applies to the Worker too.

- **`cf.image` is recognised by request options, not by host**, because its host is our own
  token-gated original route (ADR 0012) and is otherwise indistinguishable from any
  same-origin fetch.
- **An unregistered host fails loudly.** The dispatcher throws *and* records the violation;
  `afterEach` asserts the record is empty. Both, because a `scheduled()` handler that
  catches its own errors would otherwise swallow the escape and leave the suite green.

Adding a fourth vendor means adding it to `Vendor` and `HOSTS` in `test/outbound.ts`. There
is nowhere else to add it, which is the point.

## What the tooling actually does, as opposed to what is written about it

Checked against the shipped packages on 2026-09-03, because the spec this work was built
from spelled several of these differently.

- **`@cloudflare/vitest-pool-workers` has been renamed `@cloudflare/vitest-plugin`.** They
  are the same package: the `cloudflare:test` type files of `0.22.0` and `1.1.4` differ by
  exactly one comment line. Cloudflare's docs now name the new one and point existing users
  at a migration guide.
- **`defineWorkersConfig` is gone** from both. The config API is
  `cloudflareTest({ wrangler: { configPath } })`, a Vite plugin rather than a pool.
- **`fetchMock` is no longer exported at all.** Only the unexported `MockAgent` shape
  survives in the type file. The vendor-supplied outbound mock is not available, which is
  why `test/outbound.ts` is ours — and it is the better answer here anyway, because the
  ticket wanted one call log rather than three interceptors.
- **`SELF` and `env` from `cloudflare:test` are deprecated** in favour of `exports` and
  `env` from `cloudflare:workers`. `SELF.fetch()` still works and still reaches Static
  Assets, so `web/` uses it.
- **`SELF.scheduled()` is broken.** It throws
  `DataCloneError: Could not serialize object of type "LoopbackServiceStub"`. The plugin
  implements `SELF` as a Proxy whose `get` trap does `typeof target[p] === "function"`,
  and forcing that property read across the RPC boundary is what fails.
  `exports.default.scheduled({ scheduledTime })` — the documented replacement — works.
- **The published `Fetcher` type declares only `fetch` and `connect`**, so calling
  `scheduled()` on a loopback stub needs a hand-written type even though the runtime
  accepts it.
- **`getQueueResult` does not invoke the handler.** It reads the ack/retry state a batch
  ended up in. The handler call has to be explicit, and both must share one
  `ExecutionContext`.
- **`createMessageBatch` messages need an `attempts: number`**, and the retry entries it
  reports back are `{ msgId }`, not `{ messageId }`.
- **`Astro.locals.runtime.env` was removed in Astro v6** and throws. SSR routes read
  bindings from `import { env } from "cloudflare:workers"`.

## What no test here can catch

Two gaps, recorded because a rule everyone believes is enforced but is not is worse than a
rule everyone knows they have to keep themselves.

### The 10 ms CPU ceiling is not enforced by any test

`@cloudflare/vitest-plugin` does not meter CPU and does not fail an over-budget
invocation. Neither does local `workerd`: every over-budget invocation returns
`outcome: ok`. **No test in this suite can catch a CPU regression on an SSR route.** The
only signal is `npm run check:ssr-cpu`, which reports and does not enforce — see
[`measurements.md`](measurements.md).

### A module-scope Drizzle client is not caught either

ADR 0007 says a client built at module scope "also triggers *Cannot perform I/O on behalf
of a different request*". Measured on 2026-09-03 against
`@cloudflare/vitest-plugin@1.1.4`, **it does not** — that error was never produced by any
of the three wrong forms in `db/test/fixture/worker.ts`:

| Wrong form | What the local runtime does |
|---|---|
| Built at module scope | Nothing. 200. |
| Built in one request and cached for the next | Nothing. 200. |
| *Used* at module scope | Runs, at isolate startup — before migrations exist |

Only the third is observable, and only because it is severe: the query ran while the
module was being evaluated, so it saw a database with no tables in it. The 1-second
startup limit cannot be observed at all, being a deploy-time rejection.

So enforcement is structural, not behavioural:

```sh
npm run check:source-rules
```

`scripts/check-source-rules.mjs` fails the build on a module-scope Drizzle client, and on
`domain/` importing the database layer, a Node builtin, any package, or calling `fetch`.
It runs as the first step of `npm test`. `db/test/module-scope-is-wrong.test.ts` keeps the
gap versioned: if a future runtime starts enforcing the rule, those tests fail, and that
failure is the good news that the guard can be retired.
