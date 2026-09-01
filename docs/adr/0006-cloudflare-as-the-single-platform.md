# Cloudflare is the whole platform, and that means SQLite instead of Postgres

Pawster runs on Cloudflare Workers with Static Assets, D1, R2 and Queues, plus Resend for email and Healthchecks.io as a watchdog. The research left two recommendations pointing at different databases — issue #2 arrived at Cloudflare and D1, issue #3 at Neon — and this ADR resolves that in favour of **one vendor**.

The tempting argument for D1 was that an on-platform database fits the 10 ms CPU ceiling. That argument is false and should not be repeated: Cloudflare meters CPU, not wall time, and the docs are explicit that "waiting on network requests … does not count toward CPU time". A round trip to Neon would have cost nothing against the budget.

The real case is narrower and holds anyway. Pawster's data is a few dozen shelters, low thousands of animals, structured filters on six axes, and a digest sent-set. There is no query here that SQLite struggles with, and D1 supports FTS5, so even "we'll need Postgres for Spanish full-text search" is not a reason to leave. Against that, Neon is a second vendor, a second account, a second failure mode and a second thing to hold in your head at 2am — while D1, being SQLite, runs locally and in CI from a real file on disk with no network and no credentials, which is precisely the test suite this project is meant to demonstrate.

A reviewer may expect Postgres. Reaching for it here would be architecture heavier than the problem, which is the one thing the project set out not to do.

Queues resolves the same way. Issue #6 recommended Upstash QStash because it was the only surveyed scheduler that retries and dead-letters — sound reasoning, made before the host was chosen. Cloudflare Queues is now included on the Workers Free plan (10,000 operations/day), gives retries and a dead-letter queue natively, and needs no third account.

## Consequences

- **Fan-out is forced, for two independent reasons.** The Free plan allows 50 subrequests per invocation, and D1 queries count against the same 50; and the 10 ms CPU limit applies to `scheduled` handlers identically. Neither an SSR page nor a digest run may do unbounded work in one invocation.
- **R2 is the only component that bills instead of failing.** Workers, D1 and Queues all return errors when the free tier is exhausted, which is what a hard-$0 project wants. R2 charges. The $0 constraint there is enforced by our code — photo count and byte caps per animal and per unverified shelter — with Cloudflare billing alerts only as a backstop.
- **Nothing inside Cloudflare can report a cron run that never fired.** There is no Workers or Cron entry in Cloudflare's notification catalogue and no documented retry policy for `scheduled` invocations, so the external dead-man's switch from issue #6 stays. It must live outside Cloudflare or it shares the failure it exists to detect.
- **Queues messages are retained 24 hours on Free and are not the source of truth.** The per-subscription sent-set in D1 is; a message lost to retention is picked up by the next run.
- **No card fields on the site, ever.** Cloudflare's Self-Serve Agreement bars processing card data on a free-services property. This costs nothing given the listing-only decision, but it is a standing constraint, not an oversight.
- The binding free-tier limits, and what would push each past $0, are recorded on issue #9. The named escape hatch is the $5/month Workers Paid plan, triggered by consistent `exceededCpu` on SSR routes — not by traffic.
- D1 has no wire protocol, so third-party GUI clients do not attach. Production is queried through the REST API or `wrangler d1 execute`, and those queries count against the daily quota.
- What would reverse the database choice: needing something SQLite genuinely lacks — concurrent heavy writes, or relational work beyond structured filters — or exceeding 100,000 row-writes/day, of which the digest sent-set is the main consumer. Migrating a schema this small is a real cost but not a large one.
