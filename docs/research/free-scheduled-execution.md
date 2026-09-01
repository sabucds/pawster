# Free scheduled execution for the digest job

Research for [issue #6](https://github.com/sabucds/pawster/issues/6). Resolved 2026-09-01.

All figures below come from the vendors' own current documentation, fetched directly. Anything a
vendor does not document is marked **UNCONFIRMED** rather than guessed at — for this question the
undocumented gaps matter as much as the published numbers.

---

## The answer in one paragraph

**No free scheduler is reliable enough on its own, and the differences between them matter less than
the architecture wrapped around them.** Every option surveyed can silently fail to fire, and — with
one partial exception — none of them will tell you when that happens. So the recommendation is not a
vendor, it is a shape: **a scheduler that owns retries and dead-lettering (Upstash QStash) triggering
a thin enqueue endpoint, a fan-out decomposed into one independently-retried message per recipient
batch, a reconciliation-based digest that self-heals a missed run, and an external dead-man's-switch
(Healthchecks.io free) that alerts a human when the run does not happen at all.** The dead-man's
switch is not a nice-to-have; it is the only component in the whole design that can detect the exact
failure the ticket is worried about.

A second, smaller finding reframes the fan-out question entirely: **on free email tiers the fan-out
is far too small to threaten any timeout.** Resend's free plan caps sending at 100 emails/day and its
batch endpoint takes 100 emails per call — so a full day's digest is *one* HTTP request. The
execution-timeout trap the ticket anticipated is real for the paid future, not for the $0 present.

---

## Option-by-option

### 1. Vercel Cron Jobs — Hobby plan

| Property | Value |
| --- | --- |
| Jobs per project | 100 (all plans) |
| Minimum interval | **Once per day** |
| Scheduling precision | **Per-hour (±59 min)** |
| Execution timeout | **300 s**, default *and* maximum — no `maxDuration` headroom on Hobby |
| Retries | **None** |
| Log retention | **1 hour** |
| Alerting | None. Log Drains are not available on Hobby. |

**Granularity.** Hobby is restricted to daily schedules, and this is enforced at deploy time, not
silently:

> "Hobby accounts are limited to cron jobs that run **once per day**. Cron expressions that would run
> more frequently will fail during deployment." — [usage-and-pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)

> "Vercel may invoke these cron jobs at any point within the specified hour to help distribute load
> across all accounts. For example, an expression like `0 8 * * *` could trigger an invocation anytime
> between `08:00:00` and `08:59:59`." — [manage-cron-jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)

For a *daily* digest the ±59-minute jitter is genuinely harmless. Nobody notices a digest arriving at
08:41 instead of 08:00. This is the one place where a Hobby limitation costs us nothing.

**Timeout and fan-out.** 300 s with a hard ceiling; exceeding it returns
`504 FUNCTION_INVOCATION_TIMEOUT` and the function is terminated. Vercel's own advice when the work
does not fit is to stop trying to fit it:

> "if you need more processing time, it's recommended to split your cron jobs into different units or
> distribute your workload by combining cron jobs with regular HTTP requests with your API."

There is **no retry**: "Vercel will not retry an invocation if a cron job fails."

**The silent-failure quote.** This is the most important sentence found in the entire survey:

> "Cron job delivery is best effort. Most invocations run as scheduled, but occasional transient
> network errors can prevent a request from reaching your function. In those cases, your function does
> not execute, **and no runtime log is created for that scheduled run**." … "Cron delivery can also
> occasionally invoke the same scheduled run more than once."

A missed run leaves *no trace at all*. Combined with 1-hour log retention on Hobby, a digest that
stops sending is undetectable from inside Vercel. Vercel's remedy is idempotent,
reconciliation-based design — advice this document adopts wholesale (see *Reconciliation* below).

**Inactivity.** No documented project-inactivity auto-pause for cron. If Hobby *usage limits* are
exceeded: "you will have to wait until 30 days have passed before you can use the feature again"
([plans/hobby](https://vercel.com/docs/plans/hobby)). A daily cron is nowhere near the fair-use
guidelines (4 CPU-hrs/month, 1M invocations/month).

**The blocker nobody expects — Hobby is contractually non-commercial.**

> "**Hobby teams are restricted to non-commercial personal use only.** All commercial usage of the
> platform requires either a Pro or Enterprise plan." … "Commercial usage is defined as any Deployment
> that is used for the purpose of financial gain of **anyone** involved in **any part of the
> production** of the project, including a paid employee or consultant writing the code." …
> "**Asking for Donations fall under commercial usage.**"
> — [fair-use-guidelines](https://vercel.com/docs/limits/fair-use-guidelines)

A shelter-adoption platform is exactly the kind of site that grows a "donate" link. The moment it
does, Vercel Hobby is a terms violation regardless of traffic. This is a licensing constraint, not a
technical one, and it applies to the whole app on Vercel Hobby — not just the cron.

**Endpoint security.** The cron target is a public production URL invoked by HTTP GET. Vercel sends
the `CRON_SECRET` env var as an `Authorization: Bearer` header; the endpoint must check it. Cron jobs
do not follow redirects, and a redirect or cached response produces **no log entry**.

---

### 2. GitHub Actions scheduled workflows

| Property | Value |
| --- | --- |
| Minimum interval | **5 minutes** |
| Job timeout | **360 min** default and effective max (6 h hard runner limit) |
| Free minutes | Unlimited on **public** repos (standard runners); 2,000 min/month on private (Free plan) |
| Concurrency | 20 jobs (Free) |
| Retries | None documented |
| Log retention | 90 days default (public repos configurable 1–90) |

By raw numbers this is the most generous option in the survey — 6 hours of execution and unlimited
free minutes on a public repo dwarf everything else. It is also the option with the **three
independent silent-failure modes**, which is why it is not recommended.

**Trap (a): runs are dropped under load, by design.**

> "The `schedule` event can be delayed during periods of high loads of GitHub Actions workflow runs.
> High load times include the start of every hour. **If the load is sufficiently high enough, some
> queued jobs may be dropped.** To decrease the chance of delay, schedule your workflow to run at a
> different time of the hour."
> — [events-that-trigger-workflows](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#schedule)

Not "delayed" — *dropped*. And "the start of every hour" is exactly where a naively-written digest
cron (`0 8 * * *`) lands.

**Trap (b): scheduled workflows are auto-disabled after 60 days of inactivity.**

> "In a public repository, scheduled workflows are automatically disabled when no repository activity
> has occurred in 60 days."

> "When a public repository is forked, scheduled workflows are disabled by default."

This is the trap the ticket named, and it is worse than it sounds for a finished side project: a
shelter platform in maintenance mode is *precisely* a repo with no commits for 60 days. The docs
**do not define what counts as "repository activity"**, **do not state that an email is sent**, and
**do not describe the private-repo behaviour at all** — all three are UNCONFIRMED from primary
sources. Re-enabling is manual (`gh workflow enable`, the UI, or the REST API).

**Trap (c): the terms-of-service clause.**

> "Actions should not be used for: … **If using GitHub-hosted runners, any other activity unrelated to
> the production, testing, deployment, or publication of the software project associated with the
> repository where GitHub Actions are used.**" Misuse "may result in termination of jobs, restrictions
> in your ability to use GitHub Actions, disabling of repositories … or in some cases, suspension or
> termination of your GitHub account."
> — [GitHub Terms for Additional Products and Features](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)

Sending production email to end users is arguably runtime business logic, not "production, testing,
deployment, or publication of the software project". It is a judgment call GitHub does not clarify,
and the downside is account-level. Not a risk worth taking for a $0 saving.

**Observability.** Failure notifications are **opt-in**, and the recipient rule is fragile:

> "Notifications for scheduled workflows are sent to the user who initially created the workflow." …
> "If a different user updates the cron syntax … subsequent notifications will be sent to that user
> instead." … "If a scheduled workflow is disabled and then re-enabled, notifications will be sent to
> the user who re-enabled the workflow."

And critically: notifications fire on runs that *completed with a status*. A run dropped from the
queue never reaches a status, so **there is no notification for a dropped run** — the same blind spot
as Vercel, reached by a different route.

---

### 3. Cloudflare Workers Cron Triggers

| Property | Value (Workers Free) |
| --- | --- |
| Minimum interval | **1 minute** (5-field cron) |
| Cron Triggers | **5 per account** (250 on Paid) |
| **CPU time per Cron Trigger** | **10 ms** |
| Wall-clock duration per Cron Trigger | 15 min (both plans) |
| Subrequests per invocation | **50** (10,000 on Paid) |
| Daily requests | 100,000, resets midnight UTC |
| Retries | On by default; handler opts out via `controller.noRetry()` |
| Observability | Workers Logs on Free, **3-day retention**, 200k events/day; dashboard "Past Cron Events" keeps the **last 100 invocations** |

**The 10 ms surprise.** The free plan gives a cron invocation the same CPU budget as an HTTP request —
ten milliseconds ([limits](https://developers.cloudflare.com/workers/platform/limits/)). The generous
30-second and 15-minute cron CPU allowances in the docs are **Paid-plan rows**. This rules Cloudflare
out as the place where digest HTML gets rendered for N recipients.

It does **not** rule it out as a *trigger*, because CPU time and wall time are different meters:

> "CPU time measures how long the CPU spends executing your Worker code. **Waiting on network requests
> … does not count toward CPU time.**"

A Worker whose whole job is `await fetch(APP_ENDPOINT)` spends well under 10 ms of CPU while waiting
minutes of wall time. So Cloudflare is a perfectly good *scheduler* and a bad *worker* on the free
plan.

**Fan-out ceiling.** 50 subrequests per invocation, explicitly per-invocation. A fan-out that makes
one HTTP call per recipient hits the wall at 50 recipients — a much lower ceiling than any timeout.
Free-plan escape hatches do exist: **Cloudflare Queues is available on Free** (10,000 operations/day,
24 h non-configurable message retention) and **Workflows is available on Free** (100 concurrent
instances, 1,024 steps, 100,000 executions/day shared with the Workers limit, 3-day instance
retention). Durable Objects on Free are SQLite-backend only.

**Best free observability of the five.** The dashboard's Past Cron Events view keeps the last 100
invocations, Workers Logs is included on Free with 3-day retention, and `ctx.waitUntil` failures are
recorded as the invocation status. Tail Workers and Logpush are Paid-only.

**UNCONFIRMED (and these are real gaps):** no documented timing-accuracy disclaimer for per-run drift
(only a note that trigger *config changes* take up to 15 minutes to propagate); whether cron
invocations count against the 100,000/day request cap and whether the cron stops firing when it is
hit; retry count/backoff beyond the `noRetry()` opt-out; whether alerting exists on Free; and any
inactivity-disable policy. Cloudflare simply does not say.

---

### 4. Upstash QStash

QStash is **not compute**. It is "a serverless messaging and scheduling solution" that "acts as a
middleman between you and an API" — it holds the schedule and makes the HTTP call; your endpoint
still has to live somewhere. That separation is precisely why it is the recommendation.

| Property | Free tier |
| --- | --- |
| Messages/day | **1,000** |
| Active schedules | **10** |
| Minimum interval | 1 minute (standard cron; up to 60 s to first load a new schedule) |
| **Max HTTP response duration** | **15 minutes** |
| Retries | **3 by default**, exponential backoff `min(86400, e^(2.5n))` s ≈ 12 s, 2 m28 s, 30 m, 6 h, capped 24 h |
| Dead-letter queue | Yes, **3-day** retention |
| Logs retention | 3 days |
| Max message size / delay / parallelism | 1 MB / 7 days / 10 |
| Delivery guarantee | **At-least-once** — design for duplicates |

Three properties make this the strongest free option:

1. **Its timeout is longer than any free compute it could call.** 15 minutes on the *free* tier, versus
   Vercel Hobby's 300 s, Supabase Edge Functions' 150 s, and Cloudflare's 10 ms CPU. The scheduler is
   never the thing that times out.
2. **Retry and dead-lettering are the scheduler's job, not yours.** A failure — non-2xx *or* exceeding
   the response duration — is retried three times with exponential backoff, then dead-lettered.
   Vercel, GitHub Actions and Supabase/pg_net all give you exactly zero retries.
3. **It is the only option with a push failure signal.** *Failure callbacks* — "called only when all
   the retries are exhausted and still the message cannot be delivered" — hit an endpoint you control.
   Every other option requires you to go and look at a log that has already expired.

**Fan-out primitives.** One schedule can become N independently-retried messages:

- **Batch publish** — one call publishes an array of messages to different destinations. "If one
  message fails to be sent, that message will have an error response, but the other messages will
  still be sent."
- **URL Groups** — "When you publish a message to a URL Group, it will be fanned out and sent to all
  the subscribed endpoints", enqueuing "a unique task for each subscribed endpoint". Free tier: 1
  group, 100 endpoints.
- **Flow control** — `rate` and `parallelism` caps per key, so the fan-out cannot stampede the
  downstream endpoint or trip the email provider's rate limit.
- **`Upstash-Delay`** — relative delay per message, up to 7 days on Free, for spreading a fan-out.

**UNCONFIRMED:** QStash-specific inactivity policy. Upstash documents that free *Redis* databases "are
archived after a minimum of 30 days of inactivity" with warning emails; no equivalent statement exists
for QStash. Do not assume either way — this is one more reason the dead-man's-switch is mandatory.

---

### 5. Supabase scheduled functions (pg_cron)

| Property | Free tier |
| --- | --- |
| Minimum interval | **1 second** (`[1-59] seconds` syntax, requires Postgres ≥ 15.1.1.61) |
| Concurrency guidance | ≤ 8 concurrent jobs recommended; pg_cron supports 32; ≤ 10 min per job |
| Edge Function wall-clock | **150 s** (Paid 400 s) |
| Edge Function CPU | 2 s; memory 256 MB |
| Edge Function invocations | 500,000/month included |
| Database size / egress | 500 MB / 5 GB + 5 GB cached |
| Active projects | **2** |
| Log retention | **1 day** |

Finest granularity of the five and free compute co-located with the data — and disqualified anyway by
the first row of its own limitations.

**The 7-day pause.** [free-project-pausing](https://supabase.com/docs/guides/platform/free-project-pausing):

> "A Free plan project is considered inactive if it does not receive sufficient user database activity
> over the past week." … "Typically a few user requests to the database each day over the previous
> week is enough to keep the project from being paused."

and [going-into-prod](https://supabase.com/docs/guides/platform/going-into-prod):

> "We may pause applications on the Free Plan that exhibit low activity in a 7-day period to save on
> server resources."

A paused project can be restored for up to 1 year, manually, from the dashboard.

**The open question that decides it.** Supabase defines activity as "**user** requests to the
database" and "API calls to your project or sending requests via your connected application". It
**never states whether pg_cron's own internally-scheduled executions count**. If they do not — and the
wording leans that way — then a low-traffic shelter site during a quiet week gets paused, the digest
stops, *and pg_cron cannot wake it up because pg_cron is the thing that got paused*. That is a
self-silencing failure mode, and it is undocumented in both directions. Verifiable only empirically
(idle a free project for 8+ days with nothing but pg_cron running), and not something to build a
digest engine on before that test passes.

**pg_net is weaker than it looks.** The standard pattern is pg_cron + pg_net calling an Edge Function.
[pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) documents a **2000 ms default
timeout**, responses "stored for 6 hours in the `net._http_response` table" and then dropped, and
**no retry mechanism at all**. Requests do not start until the calling transaction commits.

**Observability.** Run history is `cron.job_run_details`, which "[is] not cleaned up automatically" —
it grows unbounded and outlives deleted jobs, so it needs its own pruning. Free-tier log retention is
1 day. No purpose-built cron-failure UI or alerting was found for Free; detection is polling
`cron.job_run_details` yourself.

**Long-running jobs** "may show timeout errors"; Supabase's advice is to wrap queries in functions
with custom timeouts. Whether pg_cron prevents an overlapping second run of the same job while the
first is still executing is UNCONFIRMED for Supabase specifically.

---

## What actually happens when a fan-out exceeds the timeout

Asked directly, per option:

| Option | Behaviour on overrun | Recovery |
| --- | --- | --- |
| Vercel Hobby | Terminated at 300 s, `504 FUNCTION_INVOCATION_TIMEOUT`. Work not already persisted is lost. | **None.** No retry. Next run only, and only if the job is reconciliation-based. |
| GitHub Actions | Cancelled at `timeout-minutes` (default/max 360), job marked failed. | None built in. 6 h is so generous that overrun is unlikely to be the failure mode. |
| Cloudflare Free | Two separate ceilings: 10 ms **CPU** and 15 min wall. Also a hard 50-subrequest cap that bites long before either. | Retries on by default (details undocumented). Queues/Workflows on Free can chunk the work. |
| QStash | 15-min response duration counts as a failure → 3 retries with exponential backoff → DLQ (3 days). | **Automatic**, plus a failure callback. |
| Supabase pg_net | 2 s default timeout, request abandoned. | **None.** No retries; response row gone after 6 h. |

**But this is largely a hypothetical on free tiers.** The email provider caps the fan-out far below
any timeout:

| Provider | Free send cap | Batch size | Rate limit |
| --- | --- | --- | --- |
| Resend | **100 emails/day**, 3,000/month, 3 domains, 30-day data retention | **100 per batch call** | 10 req/s per team |
| Brevo | 300/day (widely stated; not re-verified here — **UNCONFIRMED**) | — | 1,000 RPS / 3.6M RPH on Free–Standard |

On Resend's free tier a *full day's* digest is one batch call of ≤100 emails. Nothing in that
sequence approaches 300 s, let alone 15 minutes. **The scheduler timeout is not the binding
constraint at $0 — the email daily cap is.** The fan-out architecture below is therefore built for
the day the cap is lifted, not for launch day.

---

## Recommendation

### The shape

```
Healthchecks.io  ◄── /start & /success pings ──┐
  (dead-man's switch, alerts a human)          │
                                               │
QStash schedule (daily cron)                   │
        │  HTTP POST + signature               │
        ▼                                      │
  /api/digest/plan   ── enumerates due subscriptions,
        │                writes a run record, pings ──┘
        │  QStash batch publish: one message per batch of ≤100 recipients
        ▼
  /api/digest/send   ── renders + sends one batch via the email provider's
                        batch endpoint, advances each subscription's watermark
        │
        └── failures → QStash retries ×3 (exp. backoff) → DLQ → failure callback → /api/digest/failed
```

### Why this shape

**Separate the trigger from the worker.** Every free compute tier has a short timeout; QStash's free
tier waits 15 minutes. Putting the schedule outside the app means the app's timeout only has to cover
*one batch*, never the whole run.

**Make the fan-out N independent messages, not one long loop.** One timed-out recipient must not cost
the other 499. QStash batch publish gives each batch its own retry lifecycle and its own DLQ entry;
flow control keeps the send rate under the email provider's 10 req/s.

**Reconciliation, not deltas.** Store a `last_sent_at` watermark per subscription and have each run
send everything matching since that watermark, advancing it only on a confirmed send. This is Vercel's
own documented advice —

> "Design your operations to be **idempotent** and reconciliation-based so each run can safely
> reprocess outstanding work since the last successful run."

— and it converts the two failure modes every vendor admits to into non-events: a **missed** run is
absorbed by the next run (which simply covers a wider window), and a **duplicate** run sends nothing
because the watermark has already advanced. Given that at-least-once delivery is explicit in QStash
and "occasionally invoke the same scheduled run more than once" is explicit in Vercel, this is not
optional.

**A dead-man's switch, because nothing else can see this failure.** The survey's central finding is
that *the failure mode we care about produces no signal at any vendor*:

- Vercel: a missed run creates **no runtime log** (and logs live 1 hour anyway).
- GitHub Actions: a dropped run never acquires a status, so no notification fires; and a
  60-day-inactivity disable may not be emailed at all (UNCONFIRMED).
- Cloudflare: no documented alerting on Free.
- Supabase: 1-day log retention, no cron-failure UI, and a paused project cannot report that it is
  paused.
- QStash: the best of the five — failure callbacks — but those fire on *delivery* failure, not on
  "the schedule itself never fired".

Only an **external** observer with an expectation of when a ping should arrive can catch that.
Healthchecks.io's free tier is 20 checks with 100 log entries per check, supports cron-expression
schedules with a grace time, and alerts when the expected ping does not arrive by `period + grace`.
Use `/start` and `/success` pings so an over-running job is also caught ("Grace Time also specifies
the maximum allowed time gap between 'start' and 'success' signals"). Alternatives with free
heartbeat support: Better Stack (10 monitors & heartbeats, Slack + email, 3-day log retention),
UptimeRobot (50 monitors, 5-min interval, heartbeats included, 3-month retention, no card),
Cronitor (5 monitors, email + Slack).

Do **not** build the watchdog as a second job on the same scheduler — a scheduler that stops firing
stops firing its watchdog too.

### Runner-up trigger

**Cloudflare Workers Cron Triggers** if we would rather keep the scheduler inside a platform we
already use. Per-minute granularity, 5 triggers free, retries on by default, and the best free
observability in the survey (Past Cron Events + 3-day Workers Logs). The 10 ms CPU limit is not
disqualifying for a Worker whose entire body is one `fetch`, because I/O wait is not CPU. It loses to
QStash only on failure semantics: no DLQ, no failure callback, undocumented retry policy.

### Ruled out

- **GitHub Actions** — three independent silent-failure sources (drops under load, 60-day inactivity
  disable, no notification for either) plus a terms-of-service clause that plausibly forbids using
  runners for runtime business logic. The 6-hour timeout is not worth an account-level risk.
- **Supabase pg_cron as the trigger** — the 7-day pause combined with the undocumented question of
  whether cron activity counts is a self-silencing failure. pg_net's 2 s timeout and total absence of
  retries make it a poor delivery layer regardless. (Supabase remains fine as the *database*; this
  rules out only its scheduler.)
- **Vercel Hobby cron as the primary trigger** — the ±59-min jitter and daily-only cadence are
  acceptable for a digest, and 300 s is ample to enqueue. It is ruled out on non-technical grounds:
  the Hobby plan is "non-commercial personal use only" and "asking for Donations fall under commercial
  usage", which a shelter platform is likely to trip.

### Triggers to move to paid

Per the map's rule that every ADR names the free tier's real limit and what would force a move:

| Component | Free limit | Move-to-paid trigger |
| --- | --- | --- |
| QStash | 1,000 messages/day; 10 schedules; 3-day DLQ/log retention | >1,000 digest messages/day — i.e. >100,000 recipients/day at 100 per batch. Effectively unreachable before the email tier forces the move first. |
| Resend | **100 emails/day**, 3,000/month | **The real ceiling: 100 subscribers receiving a daily digest.** This is the first wall the product hits. |
| Healthchecks.io | 20 checks, 100 log entries/check | Never, at this scale. |
| Cloudflare (if used as trigger) | 5 cron triggers/account, 10 ms CPU, 50 subrequests | Any work done *inside* the Worker beyond one fetch. |

The honest headline for the ADR: **the digest's free-tier ceiling is ~100 recipients per day, and it
is set by the email provider, not by any scheduler.**

---

## Findings that surprise people who assume this is easy

1. **A missed Vercel cron run leaves no log at all.** Not a failed log — no log. Combined with 1-hour
   Hobby retention, the failure is invisible from inside the platform.
2. **GitHub explicitly documents that scheduled runs may be *dropped*, not merely delayed**, and names
   "the start of every hour" as the risky slot — the exact slot a hand-written digest cron picks.
3. **Vercel Hobby forbids commercial use, and "asking for Donations fall under commercial usage".**
   A licensing constraint that outranks every technical one for a shelter platform.
4. **GitHub's terms bar using hosted runners for "any other activity unrelated to the production,
   testing, deployment, or publication of the software project"** — with account suspension as a
   listed remedy. Using Actions as the app's production cron is a policy risk, not just a reliability
   one.
5. **Cloudflare's free cron CPU budget is 10 ms, not 30 seconds.** The generous numbers in the limits
   table are the Paid column. Separately, 50 subrequests/invocation caps a naive fan-out at 50
   recipients — a lower ceiling than any timeout.
6. **Supabase's 7-day free-project pause may be un-survivable by design**: it is undocumented whether
   pg_cron's own runs count as the "user database activity" that prevents pausing, and a paused
   project cannot run the cron that would have kept it alive.
7. **pg_net has a 2-second default timeout and no retries whatsoever**, and drops response rows after
   6 hours — a much weaker delivery layer than the pg_cron pattern's popularity suggests.
8. **The free email tier, not the scheduler, is the binding constraint.** Resend free is 100
   emails/day with a 100-per-call batch endpoint, so the entire fan-out is one HTTP request. The
   execution-timeout trap is a future problem, not a launch problem.
9. **Exactly one of the five options can push a failure signal to you** (QStash failure callbacks),
   and even it cannot tell you the schedule never fired. Everything else is poll-a-log-that-expires.
10. **Every option's retry story is worse than assumed**: Vercel none, GitHub none, Supabase/pg_net
    none, Cloudflare undocumented, QStash 3 with exponential backoff. Four of five require the
    application to be reconciliation-based or data is simply lost.

---

## Sources

**Vercel** — [Cron Jobs](https://vercel.com/docs/cron-jobs) ·
[Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs) ·
[Usage & Pricing for Cron Jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing) ·
[Functions limitations](https://vercel.com/docs/functions/limitations) ·
[Runtime logs](https://vercel.com/docs/logs/runtime) ·
[Hobby plan](https://vercel.com/docs/plans/hobby) ·
[Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines)

**GitHub** — [Events that trigger workflows — `schedule`](https://docs.github.com/en/actions/reference/events-that-trigger-workflows#schedule) ·
[Disable and enable workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows) ·
[Actions limits](https://docs.github.com/en/actions/reference/limits) ·
[Billing for GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) ·
[Workflow syntax](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions) ·
[Notifications for workflow runs](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs) ·
[Terms for Additional Products and Features](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)

**Cloudflare** — [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) ·
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) ·
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) ·
[Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) ·
[Context (`waitUntil`)](https://developers.cloudflare.com/workers/runtime-apis/context/) ·
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/) ·
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) ·
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) ·
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) ·
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) ·
[Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) ·
[Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/)

**Upstash QStash** — [Pricing](https://upstash.com/pricing/qstash) ·
[Pricing docs](https://upstash.com/docs/qstash/overall/pricing) ·
[Schedules](https://upstash.com/docs/qstash/features/schedules) ·
[Retry](https://upstash.com/docs/qstash/features/retry) ·
[DLQ](https://upstash.com/docs/qstash/features/dlq) ·
[Callbacks](https://upstash.com/docs/qstash/features/callbacks) ·
[Batch](https://upstash.com/docs/qstash/features/batch) ·
[URL Groups](https://upstash.com/docs/qstash/features/url-groups) ·
[Flow control](https://upstash.com/docs/qstash/features/flowcontrol) ·
[Delay](https://upstash.com/docs/qstash/features/delay)

**Supabase** — [Cron](https://supabase.com/docs/guides/cron) ·
[Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing) ·
[Going into prod](https://supabase.com/docs/guides/platform/going-into-prod) ·
[pg_net](https://supabase.com/docs/guides/database/extensions/pg_net) ·
[Edge Functions limits](https://supabase.com/docs/guides/functions/limits) ·
[pg_cron debugging guide](https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz) ·
[Pricing](https://supabase.com/pricing)

**Monitoring & email** — [Healthchecks.io pricing](https://healthchecks.io/pricing/) ·
[Healthchecks.io configuring checks](https://healthchecks.io/docs/configuring_checks/) ·
[Better Stack pricing](https://betterstack.com/pricing) ·
[Cronitor pricing](https://cronitor.io/pricing) ·
[UptimeRobot pricing](https://uptimerobot.com/pricing/) ·
[Resend pricing](https://resend.com/pricing) ·
[Resend batch send](https://resend.com/docs/api-reference/emails/send-batch-emails) ·
[Resend API rate limits](https://resend.com/docs/api-reference/introduction) ·
[Brevo API limits](https://developers.brevo.com/docs/api-limits)
