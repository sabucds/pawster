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
| A prerendered page | `env.ASSETS.fetch("/")` — the asset store holds it, so the asset router answers ahead of the Worker |
| An SSR route reading D1 | `SELF.fetch("/animales/:id")` — Drizzle client built in the handler |
| A `scheduled()` run | `exports.default.scheduled({ scheduledTime })` |
| The order a shard enqueued in | `worker.scheduled(controller, { ...env, DIGEST_QUEUE }, ctx)` with a capturing queue |
| A queue batch | `worker.queue(batch, env, ctx)`, then `getQueueResult(batch, ctx)` |

Migrations come from `db/migrations` — the same files `wrangler d1 migrations apply` runs
in production. They are read on the Node side in each `vitest.config.ts` and passed into
the isolate as a binding, because `applyD1Migrations` runs inside the Worker, where there
is no file system.

### How we know the prerendered page costs no Worker invocation

This was originally argued in a comment rather than asserted, and the argument was wrong.
It claimed `@astrojs/cloudflare`'s entrypoint "never references the `ASSETS` binding — grep
it", so a request reaching the Worker would find nothing to answer it. Grepping it says
otherwise: the built server bundle *does* reference `ASSETS` and falls back to it, and
calling the Worker's entrypoint directly with `/` returns 200 whether or not `/` is
prerendered. A `SELF.fetch("/")` status check therefore proves nothing at all.

What distinguishes the two worlds is the **asset store**, and the test asks it directly:

```ts
const asset = await env.ASSETS.fetch("https://pawster.test/");
expect(asset.status).toBe(200);
```

A prerendered page is written to `dist/client/` at build time, so the store holds it and
Cloudflare's asset router serves it ahead of the Worker — no invocation, no CPU, no count
against the 100,000 requests/day cap, which is what ADR 0007 is buying. Measured both
ways: prerendered, that binding returns 200 and the page; add `export const prerender =
false` to `index.astro` and there is no `dist/client/index.html` at all, so it returns
**404** and the test fails — while `SELF.fetch("/")` returns 200 either way, because the
Worker renders it.

A second assertion pins the served bytes to the stored ones, so `/` cannot start being
rendered per request while still passing.

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

## Neither seam: `domain/`

`domain/` is the one workspace whose tests need neither of the two seams above. It is pure,
so its tests run on plain Node with no isolate, no bindings and no migrations — and they
still install the outbound interceptor, because `domain/` reaching `fetch` indirectly is
exactly the violation `check-source-rules.mjs` cannot see.

Needing neither seam is what makes the package worth having, because its three consumers
are the prerender, the digest matcher and **the browser island that filters the listing**
(ADR 0007) — and the third is reachable no other way. No Worker test exercises the island,
so testing the module the island imports is the only way to test that code at all. Which
makes browser-importability a property the suite has to assert rather than assume:

```ts
// domain/src/browser-bundle.test.ts
await build({ entryPoints: ["src/index.ts"], bundle: true, platform: "browser" });
```

The structural check covers the *shapes* — no `node:` builtin, no `@pawster/db`, no bare
package, no `fetch` — and this covers the question an island actually asks. The test that
matters is the second one in that file, a negative control bundling `import "node:fs"` and
asserting esbuild refuses it: without it, the first assertion could pass for a bundler that
silently shims Node builtins, and would then be proving nothing.

Everything in `domain/` that depends on the time takes `now` as an argument — age bands,
staleness bands, matching — so **no test in that package waits for a clock or fakes one**.
That is a property of the interface rather than of the tests, which is why it holds for the
island and the digest too.

### The island, and why there is no third seam for it

The listing's island (#56) is the repository's first browser code, and it added **no DOM test
library and no second Vitest project**. That is not a gap left open; it is what the split above
is for. The island's own file holds only fetching, listening and writing to the DOM, and every
*decision* it makes lives in a module with no document in reach:

| What is decided | Where it lives | How it is tested |
|---|---|---|
| Which animals appear, in what order | `domain/`'s `selectListed` | `domain/src/filter-index.test.ts`, plain Node |
| What a card says, and with what emphasis | `web/src/lib/listing/card.ts` | `web/test/listing-card.test.ts`, as strings |
| What the panel's URL means | `web/src/lib/listing/criteria.ts` | `web/test/listing-filtering.test.ts` |
| The grid's shape and the reserved boxes | the page's stylesheet | `web/test/listing-page.test.ts`, over the served asset |

Two things fall out of that, and both are worth knowing before adding to it.

**"Filtering issues no network request" is asserted rather than asserted-about.** The whole
filter path is pure, so a test can drive it — and because `test/setup.ts` installs the outbound
interceptor for every test in the project, a request from anywhere in that path fails the test
by itself. `listing-filtering.test.ts` also checks the call log is empty, which catches the
case the interceptor would allow: a call to a vendor that *is* registered.

**What no test here covers is the wiring.** That `startListing` finds the right elements, that
the `change` listener is attached, that `innerHTML` is assigned to the grid — those are
observed by a person opening the page, and by the small size of the file that holds them.
Adding a DOM library would cover them, at the price of a dependency and a second project; the
judgement made in #56 was that a file with no branches in it is the cheaper place to be
careful. If that file grows a decision, the decision moves out rather than the seam moving in.

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
- **A form `POST` with no `Origin` header gets a 403**, from Astro's own
  `security.checkOrigin`, which is on by default for on-demand rendered routes. A browser
  sends the header on a form submission, so a test that omits it is testing something no
  browser does — `web/test/shelter-access.test.ts` sends it, and pins the 403 for a
  *cross*-origin post rather than turning the check off. It is load-bearing on
  `/api/refugios/codigo`, which takes no cookie and so gets no protection from
  `SameSite=Lax`.
- **`Astro.clientAddress` throws** where the adapter cannot supply an address, so code that
  wants an IP for rate limiting reads `CF-Connecting-IP` off the request itself. An
  exception on the sign-in path is a worse failure than a coarse bucket.
- **`applyD1Migrations` can be handed a slice**, which is the only way to test what a
  migration does to a table that already has rows in it. It records what it has applied in a
  `d1_migrations` table, so the database has to be one the suite's setup file has not already
  migrated: `db/test/fixture/wrangler.jsonc` binds a second, empty `MIGRATION_DB` for exactly
  this, and `db/test/migrations.test.ts` applies 0000, seeds a shelter, applies 0001, seeds
  contact points, then applies 0002. That test exists because drizzle-kit's generated 0001
  **would have failed** there — see the comment in
  `db/migrations/0001_worried_the_spike.sql` — and 0002 needed the same hand-correction plus
  a backfill, because a `DEFAULT 0` on `shelter_contact_points.position` would have left
  every one of a shelter's points claiming to be the one an adopter is offered.
- **`crypto.DigestStream` is bound on `crypto` and declared as a global, and the two do not
  meet.** `@cloudflare/workers-types` declares `class DigestStream` in the global scope;
  `workerd` binds it on `crypto`, which is the form Cloudflare's own docs use. Writing the
  global compiles and throws `ReferenceError: DigestStream is not defined` at runtime;
  writing `crypto.DigestStream` runs and does not compile, because `astro/tsconfigs/strict`
  pulls in the DOM `lib` and `crypto` types as the DOM's `Crypto`. `web/src/lib/photos/pipeline.ts`
  bridges the two in one place, with the reason next to it. This one was found by a green
  test suite running a stale bundle — the source had been changed to the global, the build
  had not been re-run, and 27 tests passed against the old bytes. `npm test` in `web/`
  builds first for exactly this reason.
- **`R2.put` will not accept a stream of unknown length.** It needs a request/response body
  or the readable half of a `FixedLengthStream`. This is why the upload route answers `411
  Length Required` to a body with no `Content-Length` rather than buffering it: the
  alternative is holding 12 MB in the isolate to discover a number the client already knew.
  It also makes the declared length self-enforcing — a body that sends more or less than it
  promised fails the write instead of quietly storing something else.
- **A `Uint8Array` body gets a `Content-Length` whether you want one or not**, so the only
  way for a test to send a body without one is a `ReadableStream` and `duplex: "half"`.
  Worth knowing before writing a test for the 411 above and watching it get a 201.
- **SQLite accepts `ALTER TABLE ... ADD <col> NOT NULL` with no default only while the table
  is empty.** With one row present it fails with `Cannot add a NOT NULL column with default
  value NULL`. Measured both ways on SQLite 3.43.2. This matters because drizzle-kit
  generates that exact statement, and every database in this project is empty today — so the
  failure is invisible until the first environment that is not.

## What no test here can catch

Two gaps, recorded because a rule everyone believes is enforced but is not is worse than a
rule everyone knows they have to keep themselves.

### The 10 ms CPU ceiling is not enforced by any test

`@cloudflare/vitest-plugin` does not meter CPU and does not fail an over-budget
invocation. Neither does local `workerd`: every over-budget invocation returns
`outcome: ok`. **No test in this suite can catch a CPU regression on an SSR route.** The
only signal is `npm run check:ssr-cpu`, which reports and does not enforce — see
[`measurements.md`](measurements.md).

### Whether a derivative comes back upright

`cf.image` is the interceptor's third vendor, so no transform runs locally and no test in
this suite has ever seen a transformed image. The pipeline depends on Cloudflare applying a
source's EXIF/`irot` orientation itself — which is why it never sends a `rotate`, since
rotating an already-upright image is the same silent failure in the other direction. The
suite pins our half (the transform carries a format and never a rotation; a rotated HEIC's
stored dimensions are transposed) and can pin no more than that.
[`measurements.md`](measurements.md#upright-derivatives-from-a-rotated-source--unverified-offline)
records the claim and the one-photo experiment that would settle it.

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

`scripts/check-source-rules.mjs` fails the build on six things: a module-scope Drizzle
client; `domain/` importing the database layer, a Node builtin, any package, or calling
`fetch`; any query outside `registerShelter()` writing `shelters.slug`; any file outside the
two store modules naming the account-email column; the `env.IMAGES` binding; and S3
credentials or presigned URLs.

Rules three and four are there because a per-route test would have to be written by whoever
adds the route that breaks the rule. A slug is an address adopters and search engines already
hold, so rewriting one breaks every URL to a shelter's archive pages (ADR 0015). An account
email is a shelter's credential and must appear in no public response and in no filter index
(issue #52) — and the filter index does not exist yet (issue #56), so there is nothing for a
test to inspect. `panel.astro` had a select naming that column and the rule is what found it.

Rules five and six are the two mechanisms ADR 0012 ruled out, and they are structural for a
different reason: they **work**. The `IMAGES` binding transforms images correctly and passes
any test written against its output, while spending 22–56 ms of Worker CPU against a 10 ms
ceiling — and nothing available locally meters CPU, so there is no test that could fail.
Presigned URLs and an S3 credential in the Worker work exactly as well as not having them,
minus a credential that can leak. Both skip comment lines, because the repository has to be
able to write *about* the decisions it forbids: `web/src/lib/images.ts` names the binding in
its own module comment in order to rule it out.

The module-scope rule catches **both** wrong forms, which matters because the second is the
common one: a
column-0 `const db = createDb(...)`, and an assignment to a module-scope name at any
indentation (`cachedDb ??= drizzle(env.DB)` inside a handler). Declarations are never
confused for assignments, so a `const db = createDb(...)` *inside* a handler that shadows a
module-scope name stays legal. It scans `*/src` **and** `*/test`, because
`db/test/fixture/` is the one directory exempt from the rule and an exemption over
unscanned files exempts nothing.
It runs as the first step of `npm test`. `db/test/module-scope-is-wrong.test.ts` keeps the
gap versioned: if a future runtime starts enforcing the rule, those tests fail, and that
failure is the good news that the guard can be retired.
