# Free-tier Postgres and idle-suspension behaviour

Research for [#3](https://github.com/sabucds/pawster/issues/3). Blocks [#9](https://github.com/sabucds/pawster/issues/9) (stack and hosting topology).

**Researched**: 2026-09-01. All facts below come from the vendors' own pricing pages, docs and
changelogs — never from comparison articles, which for this question are actively wrong (see
[Xata](#xata--disqualified-the-free-tier-no-longer-exists)).

## The question that decides it

Pawster is a listing site a Venezuelan shelter may open twice a week. Two *different* failure modes
hide under the phrase "idle suspension", and conflating them is how you pick the wrong vendor:

1. **Per-request idle suspension** — the compute scales to zero after minutes of quiet and wakes on
   the next connection. Costs one cold start, measured in milliseconds. Survivable.
2. **Project pausing / archiving after N days** — the *project* is taken offline and a human must
   click something, or the data is moved to cold storage, or eventually deleted. This takes the
   whole site down and keeps it down until the maintainer notices. Not survivable for a public site.

Supabase has (2) and not (1). Neon has (1) and not (2). That asymmetry is the whole answer.

## Recommendation

**Neon Free**, as the primary Postgres for Pawster.

Neon is the only surveyed option that is real Postgres, has a free plan the vendor calls permanent,
and **never pauses, archives-to-oblivion, or deletes a project for inactivity**. Its compute scales
to zero after 5 minutes and cannot be stopped from doing so on Free, but it
"reactivates automatically within a few hundred milliseconds"
([scale-to-zero docs](https://neon.com/docs/introduction/scale-to-zero)) — a sub-second penalty on
the first request after a quiet spell, paid by whichever visitor arrives first, and invisible
thereafter. For a site whose *worst* case is a shelter admin arriving on a Tuesday, that is the
correct trade: a cold start the visitor barely notices, instead of a dead site nobody notices.

Supabase is the strong runner-up on capability — it bundles auth and object storage, which #9 will
weigh — but on this ticket's decisive axis it fails: **free projects are paused after roughly one
week of low activity**, and resuming is a manual button press by a human with dashboard access. A
site visited twice a week is exactly the traffic profile that trips it. Supabase can be kept alive
with a cron ping, and that mitigation is cheap — but it converts "the platform keeps my site up"
into "my monitoring keeps my site up", which is the wrong dependency for a solo maintainer running a
non-profit.

The Postgres-shaped alternatives are all disqualified on this ticket's terms: **Turso** archives free
databases after 10 days of inactivity and is SQLite, not Postgres; **Cloudflare D1** has genuinely no
idle problem at all but is also SQLite and caps writes at 100,000 rows/day; **Xata's free tier no
longer exists** — the generous free plan every comparison article still quotes was retired along
with the platform that hosted it.

### The trap worth naming up front

The obvious fix for Supabase's pause — a cron job pinging the database every few minutes — is
**actively harmful on Neon**. Neon Free grants 100 CU-hours per project per month
([plans](https://neon.com/docs/introduction/plans)). At the 0.25 CU minimum that is 400 compute-hours,
but a calendar month is ~730 hours. Keeping the compute warm around the clock therefore exhausts the
month's allowance in about 16 days, after which "your compute is suspended until the next billing
period or until you upgrade" — the keep-alive causes the outage it was meant to prevent. On Neon,
letting the database sleep is not a compromise; it is the mechanism that keeps it free. Any
keep-alive instinct carried over from Supabase habits must be deliberately suppressed.

## Neon — recommended

| | |
|---|---|
| Dialect | Real Postgres (Neon runs stock Postgres) |
| Storage | 0.5 GB per project |
| Compute | 100 CU-hours per project per month; autoscaling up to 2 CU (~8 GB RAM) |
| Projects | 100 on Free; 10 branches per project |
| Egress | 5 GB public network transfer per month |
| Free plan status | "The Free plan is permanent (not a trial); no credit card required" |

Sources: [Neon plans](https://neon.com/docs/introduction/plans), [pricing](https://neon.com/pricing).

**Idle suspension.** Compute scales to zero "After 5 min" of inactivity and on the Free plan the
setting is fixed — "For Neon Free plan users, this setting is fixed", only paid plans may disable it.
Resume is automatic and documented at "a few hundred milliseconds"
([scale-to-zero](https://neon.com/docs/introduction/scale-to-zero)).

**Project pausing / deletion.** None. There is no inactivity rule that takes a Neon project offline
or deletes it. What does exist is **branch archiving**: on Free, Neon archives any branch that is
both "older than 14 days" **and** has "not been accessed for the past 24 hours"
([branch archiving](https://neon.com/docs/guides/branch-archiving)). Both conditions must hold. This
is not a pause — "No action is required to unarchive a branch. It happens automatically"; connecting
or querying triggers it. The documented cost is qualitative: branches "with large amounts of data may
experience slightly slower connection and query times while a branch is being unarchived". At
Pawster's data volume this is noise. Archiving cannot be fully disabled, and the escape hatch
(protected branches) is paid-only — so plan on the production branch being archived during quiet
weeks and unarchiving itself on the next visit.

**Connections and pooling.** `max_connections = max(100, min(4000, floor(compute_size × 419.66)))`,
where the effective size is the autoscaling maximum — so Free's 0.25–2 CU range yields ~839 direct
connections, but a *fixed* 0.25 CU compute yields only 104, of which 7 are reserved for the Neon
superuser (97 usable). Pooling is **recommended, not required**: "For most applications, we recommend
using connection pooling, which supports up to 10,000 concurrent connections regardless of compute
size" ([compatibility](https://neon.com/docs/reference/compatibility),
[connection pooling](https://neon.com/docs/connect/connection-pooling)). Use the `-pooler` endpoint
for serverless request handlers; keep a direct connection for migrations, `pg_dump` and logical
replication. Transaction-mode pooling breaks `SET`/`RESET`, `LISTEN`/`NOTIFY` and SQL-level `PREPARE`.

**Backups.** Instant restore with 6 hours of history retention (1 GB limit) plus **1 manual snapshot**
per project, at no charge on Free ([plans](https://neon.com/docs/introduction/plans)). Restore is
self-serve via console, CLI (`neon branches restore`) or API
([branch restore](https://neon.com/docs/guides/branch-restore)). Six hours is short — treat `pg_dump`
to off-site storage as the real backup story, with instant restore as the "I just ran the wrong
migration" undo. Separately, a project you delete yourself is recoverable for 7 days
([manage projects](https://neon.com/docs/manage/projects)).

**What forces a move to paid.** In likely order: (1) 100 CU-hours/month — reached only if something
keeps the compute awake, so this is a *bug* trigger more than a growth trigger; (2) 0.5 GB storage;
(3) 5 GB/month egress; (4) more than 10 branches per project; (5) needing scale-to-zero disabled, a
protected (never-archived) branch, or more than 6 h of restore history. On overage, "your compute is
suspended until the next billing period or until you upgrade", and storage overage makes writes fail
— but "None of these limits delete your data". Free is never billed; it hard-stops instead.

**Two accounting details that quietly shrink the free tier.** Storage is measured in *byte-months*
and includes instant-restore history, snapshots, and archived branches — archived branches are billed
at the same rate as active ones, so archiving saves Neon money, not you
([usage calculations](https://neon.com/docs/introduction/usage-calculations)). Branch sprawl therefore
eats the 0.5 GB. And the 5 GB egress allowance is **account-wide**, unlike storage and CU-hours which
are per project.

**Durability of the free tier.** Neon was acquired by Databricks (announced 2025-05-14,
[Databricks newsroom](https://www.databricks.com/company/newsroom/press-releases/databricks-agrees-acquire-neon-help-developers-deliver-ai-systems)).
The free plan survived the acquisition and got *better* — Free-plan compute doubled from 50 to 100
CU-hours ([Neon and Databricks](https://neon.com/blog/neon-and-databricks)). Positive signal, but
acquisition is a standing risk to any free tier; the mitigation is that Neon is stock Postgres, so
`pg_dump` walks to anywhere.

## Supabase — runner-up, disqualified on the idle axis

| | |
|---|---|
| Dialect | Real Postgres, plus auth, object storage, realtime |
| Database size | 500 MB (Nano: shared CPU, 500 MB RAM) |
| File storage | 1 GB |
| Egress | 5 GB, plus 5 GB cached egress |
| MAUs | 50,000 |
| Projects | "Limit of 2 active projects" per organisation |

Source: [Supabase pricing](https://supabase.com/pricing).

**Idle suspension (per-request).** None — the instance is always-on shared compute, so there is no
cold start on a normal request. On the *request* axis Supabase beats Neon.

**Project pausing.** This is the disqualifier. The pricing page states plainly: "Free projects are
paused after 1 week of inactivity." The docs elaborate: pausing follows "low activity over a 7-day
period", and "A Free plan project is considered inactive if it does not receive sufficient user
database activity over the past week" — typically "a few user requests to the database each day over
the previous week" is enough to prevent it
([project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)).

Note the shape of that threshold: it wants activity *most days*, not activity *most weeks*. A weekly
digest cron plus two shelter visits does not obviously clear it. Restoring is manual — open the
dashboard, select the paused project, click "Resume project" and confirm — so the site stays down
until a human with dashboard access notices.

Supabase does warn: an email goes out roughly a week before the pause, and another once it happens.

**Restore window — and a stale source to ignore.** The live docs say "You can restore a paused
project for up to 1 year after it was paused". The widely-cited changelog of 2024-06-24, "Paused Free
Plan projects are restorable for 90 days"
([changelog](https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days)),
is **superseded** — though the docs still carry a leftover `#90-day-window-to-restore` anchor, which
is why the 90-day figure keeps circulating. After a year, "Projects paused for more than 1 year can no
longer be restored through Supabase Studio"; you download the `.backup` file plus Storage objects from
Project Overview and rebuild by hand
([troubleshooting](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause)).
Eventually the project is deleted, and "once a project is deleted, all associated data including
backups is permanently removed and cannot be recovered." **Unverified**: the delay between the 1-year
mark and actual deletion is not stated first-party. Also **unverified**: how long a resume takes —
Supabase publishes no number.

**Project quota subtleties.** The 2-project limit is per *person*, "across all organizations where
you are an Owner or Administrator" — being made admin of someone else's free org consumes your quota.
Paused projects do *not* count against it. And "Different plans cannot be mixed within a single
organization", so upgrading one project upgrades the whole org
([org-based billing](https://supabase.com/docs/guides/platform/org-based-billing)).

**Connections and pooling.** Nano (free) compute: **60** direct database connections, **200** pooler
clients ([compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk), which also
warns "Compute resources on the Free plan are subject to change"). Pooling is **effectively
mandatory on Free**, for two reasons: serverless/edge handlers need transaction mode ("Use pooler
transaction mode for application traffic from temporary clients"), and — the one that bites — direct
connections are **IPv6-only**, with the IPv4 add-on available on "Pro Plans+" only
([IPv4 address](https://supabase.com/docs/guides/platform/ipv4-address)). Supavisor is IPv4-capable on
every tier, so any IPv4-only CI runner or host must go through the pooler
([connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)).
Transaction mode does not support prepared statements — a client-config change, and a silent
breakage if missed.

**Overage behaviour.** Exceeding 500 MB puts the database into **read-only** mode rather than billing
you ([database size](https://supabase.com/docs/guides/platform/database-size)); recovery is a manual
`set session characteristics as transaction read write` → delete → `vacuum` dance. Fair-use
enforcement options are "pausing projects, switching databases to read-only mode, or responding with
a 402 status code for all API requests"
([billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)), and the size check runs on
*average daily* size across the billing period — so shrinking the database does not lift the
restriction immediately. Free is never billed.

**Backups.** **None on Free.** "We automatically back up all Pro, Team, and Enterprise Plan projects
on a daily basis"; free projects are told to "regularly export their data using the Supabase CLI
`db dump` command and maintain off-site backups". PITR is a paid add-on
([backups](https://supabase.com/docs/guides/platform/backups)). If Supabase is chosen for anything,
a scheduled `pg_dump` is not optional. One exception: a single logical backup is taken immediately
before a pause and stays downloadable from Project Overview while the project is paused.

**What forces a move to paid.** Most likely: wanting the project to *stop pausing* (upgrading to Pro
is the documented fix), or needing a third active project, or wanting any backups at all. Storage and
MAU limits are generous relative to Pawster's shape and will not bind first.

**If #9 picks Supabase anyway** (a real possibility, since it bundles auth for shelters and object
storage for animal photos, collapsing three tickets into one vendor): the pause must be treated as a
designed-around risk, not a footnote. The mitigation is a cheap **external** cron hitting a
lightweight endpoint daily. Nothing in Supabase's docs forbids a keep-alive — the pausing page itself
names "making API calls to your project or sending requests via your connected application" as an
accepted way to stay active — and this is safe on Supabase precisely because Supabase does not meter
compute hours on Free. Two cautions: the same trick would bankrupt a Neon project's CU-hour budget,
and it must be *external*. **Unverified**: whether an internal `pg_cron` job counts as "user database
activity" for the pause heuristic — the docs only ever cite external requests and dashboard visits,
so a self-ping from inside the database is an untested bet on which the whole site would rest.

## Turso — disqualified: SQLite, and archives after 10 days idle

| | |
|---|---|
| Dialect | SQLite / libSQL — **not Postgres**. "Turso is a full, ground-up rewrite of SQLite" |
| Databases | 100 |
| Storage | 5 GB |
| Rows read | 500 million/month |
| Rows written | 10 million/month |
| PITR | 1 day |

Source: [Turso pricing](https://turso.tech/pricing).

The limits are generous and the cold-start story is genuinely good: "Free users: You now get no cold
starts on AWS, because Turso on AWS is architected to work without any cold starts by default"
([Turso on AWS](https://turso.tech/blog/turso-aws-beta)).

**But the inactivity rule kills it, and it is documented nowhere near the pricing page.** The CLI
reference for `turso group unarchive` states: "Databases get archived after 10 days of inactivity for
users on a free plan" ([group unarchive](https://docs.turso.tech/cli/group/unarchive)). A ten-day
window against a twice-weekly visit pattern is thin, and the existence of an explicit `unarchive`
command implies unarchiving is at least sometimes a manual act rather than a transparent one — unlike
Neon, whose docs promise automatic unarchive on access. That a limit this decisive appears only in a
CLI subcommand's reference page, and not on the pricing page that markets the free tier, is itself a
reason for caution.

**Platform stability.** Turso publicly restructured: focus shifted to a from-scratch SQLite rewrite,
edge replicas were "discontinued for new users", multi-DB schemas and `ATTACH` were removed for new
users, infrastructure moved from Fly.io to AWS, and the announcement mentions staff reductions
([upcoming changes](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap)). The
continuity promise made there is scoped to *paid* customers: "if you're a current paid customer of
Turso, your existing production workloads will continue running exactly as they do today." Free users
were not given that sentence.

**Postgres protocol.** Turso once blogged about serving SQLite over the Postgres wire protocol, but
that post now carries the banner "This post references an older version of Turso and is kept for
archival purposes only. Do not rely on it." **Unverified** whether any current Postgres-protocol
support ships. Either way the *dialect* is SQLite, so no `jsonb`, no real enums, no PostGIS, and a
migration to Postgres later would be a rewrite of the data layer, not a connection-string change.

## Cloudflare D1 — best idle behaviour of all, wrong database

| | |
|---|---|
| Dialect | SQLite — **not Postgres** |
| Databases | 10 (Free) |
| Max database size | 500 MB (Free) |
| Storage per account | 5 GB (Free) |
| Rows read | 5 million/day |
| Rows written | **100,000/day** |
| Queries per Worker invocation | 50 (Free) |
| Time Travel (PITR) | 7 days (Free) |

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

**Idle suspension: none, and none is possible.** D1 has no persistent compute to suspend. There is no
cold start, no project pause, no inactivity archiving, and no inactivity deletion. On the axis this
ticket calls decisive, D1 is the outright winner — a site untouched for six months answers its next
query exactly as fast as one queried a second ago. It also ships the best free backup story of the
survey: 7 days of point-in-time recovery, included.

**Why it still loses.** It is SQLite. Pawster's domain model — animals with multi-valued good-with
flags, region hierarchies, filter axes across six dimensions, and a digest engine that must match
subscriber criteria against listings — is the kind of work Postgres's type system and index options
make pleasant and SQLite makes manual. The 100,000 rows-written-per-day cap is also lower than it
looks once a digest run touches subscriber and delivery bookkeeping. And the failure mode on overage
is hard: "When your account hits the daily read and/or write limits, you will not be able to run
queries against D1. D1 API will return errors to your client."

**Cloudflare has no first-party Postgres.** Hyperdrive is a connection pooler and cache that sits in
front of *someone else's* Postgres; it is not a database. A Cloudflare-hosted Pawster would still
need Neon or Supabase behind it — which is a perfectly reasonable topology for #9 to consider.

**What forces a move to paid.** The daily row-write cap, or the 5 GB account storage ceiling.

## Xata — disqualified: the free tier no longer exists

This is the finding that most justifies the ticket's insistence on primary sources.

Every comparison article still describes a Xata free plan with "15 GB of storage space, no cold
starts, and no pausing in case of inactivity" — wording that comes from Xata's own January 2025 post
[Changes to the Xata free plan](https://xata.io/blog/changes-free-tier). That plan was real. It is
also gone.

- The platform that hosted it, **Xata Lite, has been retired**. `https://lite.xata.io/` now returns
  **HTTP 410 Gone**, and the official TypeScript SDK repo is titled "[Deprecated] Xata Lite SDK".
- The current [Xata pricing page](https://xata.io/pricing) offers exactly three things: **Open
  Source** (free, but "Self-host on your own infrastructure"), **Xata Cloud** (managed, with a
  "14-day free trial", "No credit card required"), and **BYOC**. There is no free managed tier.
- Xata's core is now Apache 2.0 licensed
  ([Xata is now open source](https://xata.io/blog/xata-is-now-open-source)), which is the *reason*
  free-forever now means self-hosting rather than a hosted plan.

A 14-day trial fails the map's standing constraint of "a free tier that does not expire" outright,
and self-hosting an open-source Postgres platform means renting compute — also not $0. Xata is out.

**Unverified**: the precise retirement date of Xata Lite and whether legacy free-tier data was
exported or destroyed. Xata's own pages no longer discuss it; the 410 is the clearest first-party
evidence available.

## Summary table

| | Postgres? | Idle suspension | Cold start | Pauses/deletes on inactivity | Free backups | Verdict |
|---|---|---|---|---|---|---|
| **Neon** | Yes | Compute → zero after 5 min (fixed on Free) | "a few hundred milliseconds" | No pausing, no deletion. Branch archiving at >14 days old **and** 24 h unaccessed; auto-unarchives on access | 6 h instant restore | **Recommended** |
| **Supabase** | Yes | None (always-on shared compute) | None | **Project paused after ~1 week of low activity**; resume is a manual dashboard click; restorable for 1 year, then data eventually deleted | **None** | Runner-up; pause is disqualifying alone |
| **Turso** | No (SQLite/libSQL) | None on AWS ("no cold starts") | None | **Archived after 10 days idle** (documented only in a CLI reference) | 1-day PITR | Out |
| **Cloudflare D1** | No (SQLite) | N/A — no compute to suspend | None | **None** | 7-day Time Travel | Out on dialect, best on idle |
| **Xata** | Yes | N/A | N/A | N/A | N/A | **Out — no free tier exists** |

## What this hands to #9

- **Take Neon** unless #9 decides that bundling auth (#) and image storage (#5) into Supabase is
  worth owning the pause risk. That is a legitimate trade, but it must be made explicitly, and the
  ADR must record the keep-alive as a required component rather than an afterthought.
- **Never add a keep-alive ping to Neon.** Write this into the ADR as a warning, because it is the
  natural instinct and it silently burns the CU-hour budget into a mid-month outage.
- **Budget for `pg_dump`.** Neon gives 6 hours of history; Supabase Free gives nothing. Whichever is
  chosen, a scheduled logical dump to off-site storage is part of the stack, and it shares
  infrastructure with the digest cron in #6.
- **Storage is 0.5 GB either way**, so animal photos must not live in the database. That constraint
  belongs to #5, and this ticket confirms it is binding rather than theoretical.
- **The digest job's DB traffic is not a keep-alive.** On Neon it is irrelevant; on Supabase a weekly
  run does not clear the "a few user requests each day" bar.

## Sources

All first-party unless noted.

- Supabase: [pricing](https://supabase.com/pricing) ·
  [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) ·
  [90-day restore changelog](https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days) ·
  [restore after long pause](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause) ·
  [backups](https://supabase.com/docs/guides/platform/backups) ·
  [compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk) ·
  [connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) ·
  [IPv4 address add-on](https://supabase.com/docs/guides/platform/ipv4-address) ·
  [database size / read-only mode](https://supabase.com/docs/guides/platform/database-size) ·
  [org-based billing](https://supabase.com/docs/guides/platform/org-based-billing) ·
  [billing FAQ](https://supabase.com/docs/guides/platform/billing-faq)
- Neon: [plans](https://neon.com/docs/introduction/plans) · [pricing](https://neon.com/pricing) ·
  [scale to zero](https://neon.com/docs/introduction/scale-to-zero) ·
  [branch archiving](https://neon.com/docs/guides/branch-archiving) ·
  [connection pooling](https://neon.com/docs/connect/connection-pooling) ·
  [usage calculations](https://neon.com/docs/introduction/usage-calculations) ·
  [branch restore](https://neon.com/docs/guides/branch-restore) ·
  [manage projects](https://neon.com/docs/manage/projects) ·
  [compatibility / connection limits](https://neon.com/docs/reference/compatibility) ·
  [Neon and Databricks](https://neon.com/blog/neon-and-databricks) ·
  [Databricks acquisition press release](https://www.databricks.com/company/newsroom/press-releases/databricks-agrees-acquire-neon-help-developers-deliver-ai-systems)
- Turso: [pricing](https://turso.tech/pricing) ·
  [group unarchive (10-day rule)](https://docs.turso.tech/cli/group/unarchive) ·
  [Turso on AWS](https://turso.tech/blog/turso-aws-beta) ·
  [upcoming platform changes](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap)
- Cloudflare D1: [limits](https://developers.cloudflare.com/d1/platform/limits/) ·
  [pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Xata: [pricing](https://xata.io/pricing) ·
  [changes to the free plan (Jan 2025, now historical)](https://xata.io/blog/changes-free-tier) ·
  [Xata is now open source](https://xata.io/blog/xata-is-now-open-source) ·
  `https://lite.xata.io/` returns HTTP 410 Gone (observed 2026-09-01)
