# Free-tier application hosting and its commercial-use terms

Research for [issue #2](https://github.com/sabucds/pawster/issues/2), under the map in [issue #1](https://github.com/sabucds/pawster/issues/1).
Researched 2026-09-01. Every claim below is cited to the vendor's own page; no secondary sources were used.

**Constraints this answers against** (from the map's Notes): hard $0/month at low volume, a free tier that does not expire,
non-profit platform, one maintainer, mobile-first, Venezuelan audience, photo-heavy listings published by
third-party organisations (shelters).

---

## Answer in one paragraph

**Cloudflare Workers**, with Workers Static Assets for the listing, D1 for data and R2 for photos — because it
is the only option whose free tier does not meter the thing this product is mostly made of (photographs), and
because its terms contain no commercial-use restriction. **Deno Deploy is the runner-up** and has the friendliest
terms of anyone surveyed. **Vercel is disqualified on terms, not price**: its Hobby plan is "non-commercial
personal use only" and its own docs say asking for donations counts as commercial usage, so a non-profit is
*less* safe there, not more. **Netlify is disqualified on allowance**: new accounts get 300 credits/month, and
at 15 credits per production deploy that is twenty deploys. **Fly.io has no free tier at all** any more.
**Render's free Postgres is deleted after 30 days.** **Railway's free plan is a $1/month credit.** The price of
being wrong about Cloudflare is $5/month; the price of being wrong about Vercel is a takedown.

---

## What Pawster actually needs from a host

Worth stating before the comparison, because it disqualifies options that look generous on paper:

1. **Server-side execution**, not just static files — shelter auth, the admin verification flow, and the
   digest engine all need it. This rules out static-only hosts.
2. **A scheduled job** for the digest. Whatever the host is, it must run something on a cron without a
   separate always-on machine.
3. **Photo-heavy egress.** Every listing is an animal photo. Bandwidth and image transformation are the
   metered resources most likely to move first.
4. **Terms that permit a non-profit publishing third parties' content**, with room for a donations link later.
5. **Latency from Venezuela.** An edge/anycast network matters more here than in a US-only product;
   single-region hosts put every request across the Caribbean.
6. **No expiry and no card requirement**, per the map's standing constraint.

---

## Vercel — Hobby plan

### Terms: explicitly forbidden for Pawster's shape

This is the sharpest finding in the survey. Vercel's Hobby restriction is not vague; it is written down, it is
broad, and it is enforced by pausing the deployment rather than by sending a bill.

From the [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines), section "Commercial usage":

> **Hobby teams** are restricted to non-commercial personal use only. All commercial usage of the platform
> requires either a Pro or Enterprise plan.
>
> Commercial usage is defined as any Deployment that is used for the purpose of financial gain of **anyone**
> involved in **any part of the production** of the project, including a paid employee or consultant writing
> the code. Examples of this include, but are not limited to, the following:
>
> - Any method of requesting or processing payment from visitors of the site
> - Advertising the sale of a product or service
> - Receiving payment to create, update, or host the site
> - Affiliate linking is the primary purpose of the site
> - The inclusion of advertisements […]

and, in the same section:

> **Note:** Asking for Donations […] fall under commercial usage.

That donations note is the one that bites. A non-profit adoption platform that ever adds a "help us keep the
lights on" link, or that carries a shelter's own donation appeal on a shelter profile, is by Vercel's own
written definition doing commercial usage on a plan that forbids it. "Non-commercial" here does not mean
"not-for-profit" — it means no money changes hands anywhere near the deployment, charitable or otherwise.

The [Terms of Service](https://vercel.com/legal/terms) restate it and add the enforcement:

> You shall only use the Services under a Hobby plan for your personal or non-commercial use.

> We may shut down and terminate projects or deployments using the Hobby plan without notice for any reason
> or no reason.

The same Terms also carry a general prohibition that a platform hosting other organisations' listings should
read carefully:

> you will not, directly or indirectly: […] (iv) use the Services for timesharing or service bureau purposes
> or otherwise for the benefit of a third-party.

Read narrowly this targets reselling Vercel; read literally it covers a site whose whole purpose is publishing
third-party organisations' content. It is not plan-specific, so upgrading to Pro would not obviously cure it.
Vercel's own guidance for the ambiguous case is to ask: "If you are unsure whether or not your site would be
defined as commercial usage, please contact the Vercel Support team."

Enforcement is a pause, not an invoice. Per
[Why has my account or deployment been paused?](https://vercel.com/kb/guide/why-is-my-account-deployment-blocked),
policy violations are one of four pause causes, Vercel's team "may pause the account or deployment directly",
and "Vercel emails you with the specifics and the steps to resolve it." The page documents no notice period.
For a shelter platform, that is the difference between a surprise bill (recoverable) and every shelter's
listings going dark mid-week (not recoverable in reputation).

### Hobby limits

From [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines) and the
[Hobby plan page](https://vercel.com/docs/plans/hobby):

| Resource | Hobby |
| --- | --- |
| Fast Data Transfer (egress) | Up to 100 GB / month |
| Fast Origin Transfer | Up to 10 GB / month |
| Active CPU | Up to 4 CPU-hrs / month |
| Provisioned Memory | Up to 360 GB-hrs / month |
| Function invocations | Up to 1M / month |
| Image transformations | Up to 5K / month |
| Image cache reads / writes | 300K / 100K per month |
| Function max duration | 300s (5 min) |
| Deployments per day | 100 |
| Projects | 200 |
| Build vCPUs / memory / disk | 2 / 8 GB / 32 GB |
| Edge middleware CPU | ≤ 50 ms average CPU time |

Overage behaviour: "if you exceed your usage limits on the Hobby plan, you will have to wait until 30 days
have passed before you can use the feature again"
([Hobby plan](https://vercel.com/docs/plans/hobby), "Hobby billing cycle"). No card is required for Hobby; a
card is only collected when upgrading to Pro (same page, "Upgrading to Pro").

### Escape hatch, and why it does not qualify

The [Open Source Program](https://vercel.com/open-source-program) grants "$3,600 Vercel platform credits over
3 years", and explicitly: "If your nonprofit is fully open source, you're welcome to apply." Eligibility
requires the project be "actively being developed and maintained", "hosted on or intended to host on Vercel",
show "measurable impact or growth potential", and follow a Code of Conduct. Projects "graduate from the
program" after three years.

Pawster would plausibly qualify. But this is a **grant with an expiry date**, not a free tier, and the map's
constraint is a free tier "that does not expire". Accepting it would mean designing a migration for year four,
and an application that can be declined is not a plan. Treat it as an upside if it lands, never as the basis
for the decision.

**Verdict: rejected.** Not on price — on terms. The failure mode is a takedown, and the trigger (a donations
link on a non-profit) is one the project is likely to walk into by accident.

---

## Netlify — Free plan (credit-based)

### Terms: silent on commercial use, which is the good outcome

Netlify has no personal-use restriction anywhere in its self-serve legal stack. Three documents were checked:

- [Self-Serve Subscription Agreement](https://www.netlify.com/legal/self-serve-subscription-agreement/) —
  Section 6 covers the Free Usage Tier and says nothing about commercial or personal use.
- [Website Terms of Use](https://www.netlify.com/legal/terms-of-use/) — no commercial-use clause; the only
  content restriction is against material "which Netlify deems, in its sole discretion, to be objectionable."
- [Acceptable Use Policy](https://www.netlify.com/legal/acceptable-use-policy/) — the nearest clauses are
  "Users must not rent, lease, loan, or sell access to, or otherwise attempt to transfer any right in
  Netlify's website […] to a third party" and must not "commercially exploit the Netlify Services or website."
  Both target reselling Netlify itself, not running a commercial or organisational site on it. No restriction
  on hosting other organisations' content.

So a non-profit hosting shelters' listings is unobjectionable to Netlify. What the Free tier *does* carry is
discretion:

> Netlify's Free Usage Tier is made available by Netlify to allow users to experience Netlify's Services, but
> the Free Usage Tier is offered at Netlify's sole discretion. […] Netlify reserves the right to change the
> terms and conditions applicable to the Free Usage Tier, or to discontinue it.

> Netlify may shut down Free Usage Tier website projects without notice for any reason or no reason.

Section 5 also states that a Free Usage Tier customer exceeding capacity "will incur and agrees to pay
additional fees that reflect actual usage" — but this is contradicted in practice by the current Free plan's
hard credit cap (below), which pauses rather than bills. The contract language survives from the pre-credit era.

### The Free plan is much smaller than its reputation

Netlify moved to credit-based pricing for **all new accounts created on or after September 4, 2025**
([Credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)).
A new Pawster account gets the credit plan, not the legacy "100 GB bandwidth / 300 build minutes" plan people
still quote. The switch is one-way: "Switching to Credit-based plans is irreversible."

Free plan: **300 credits/month, hard limit, no auto-recharge and no option to buy more.**

Credit prices, from [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/):

| Resource | Cost | What 300 credits buys, if spent only here |
| --- | --- | --- |
| Production deploy | 15 credits each | **20 deploys/month** |
| Bandwidth | 20 credits per GB | **15 GB/month** |
| Compute | 10 credits per GB-hour | 30 GB-hours |
| Web requests | 2 credits per 10,000 | 1.5M requests |
| Form submissions | free | — |

Other Free-plan limits from the same docs: 1 concurrent build, 1 Team Owner and no additional team members,
500 projects, Netlify Database limited to 3 databases / 20 active branches / 7-day backup retention, analytics
for the current and past day only, standard email support.

At 100% of credits:

> Once your credit balance is completely used up, all of your web projects (sites/apps) are paused and
> visitors to your web projects will find a `Site not available` page at each of your web project's URLs.

Pausing is account-wide, not per-project. Warning emails arrive at 50%, 75%, 90% and 100%
([Billing FAQ](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/)).
No credit card is required on Free; a saved payment method is required only for the Personal and Pro plans.

**The binding limit is 20 production deploys per month.** Not bandwidth, not compute — deploys. A solo
maintainer merging to main a few times a week exhausts the entire month's credits on CI alone, before a single
adopter loads a page. And a photo-heavy listing site at 20 credits/GB has roughly 15 GB of egress to spend, so
the two limits compete for the same 300 credits.

**Verdict: rejected.** The terms are fine; the allowance is not. 20 deploys/month is incompatible with active
development, and an exhausted month takes the whole site down rather than degrading it.

---

## Cloudflare — Workers / Pages, Free plan

### Terms: the photo clause did not disappear, it moved

The clause everyone warns about — the old **Section 2.8, "Limitation on Serving Non-HTML Content"**, which
restricted free plans from serving a disproportionate share of images, video and other non-HTML content — is
genuinely gone from the [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) (effective
**September 12, 2025**). That agreement runs 2.1 through 2.7 and the strings "2.8", "non-HTML" and
"disproportionate" do not appear in it:

- 2.1 Access to Services
- 2.2 Use of Services
- 2.3 Credentials
- 2.4 Subscription Terms, Renewals, and Cancellations
- 2.5 Customer Content and Network Data
- 2.6 Free & Trial Services
- 2.7 Acceptable Use

**But the substance survives, relocated.** It now sits in the
[Application Services Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/)
(last updated **June 02, 2026**), under the heading "Content Delivery Network (Free, Pro, or Business)":

> Cloudflare's content delivery network (the "CDN") Service can be used to cache and serve web pages and
> websites. Unless you are an Enterprise customer, Cloudflare offers specific **Paid Services** (e.g., the
> Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via
> the CDN. Cloudflare reserves the right to disable or limit your access to or use of the CDN […] if you use
> or are suspected of using the CDN without such Paid Services to serve video or **a disproportionate
> percentage of pictures, audio files, or other large files**. We will use reasonable efforts to provide you
> with notice of such action.

Anyone who checks only the main terms and concludes the risk is gone has checked the wrong document. This was
nearly the wrong answer in this very research.

Against it sits the
[Developer Platform Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-developer-platform/)
(also **June 02, 2026**, covering Workers, Pages, KV, D1, Durable Objects, Vectorize, Hyperdrive, Queues, R2,
Containers and Workers for Platforms):

> **Unlike most Cloudflare products, the Developer Platform can be used to host content.** Content stored on
> the Developer Platform […] that we determine in our sole judgment to be illegal, harmful, or in violation of
> Section 4 […] may be blocked or removed[.]

and:

> Cloudflare may temporarily limit your storage and/or the number of requests you can make or receive using
> the Developer Platform if processing such requests would put an undue burden on the Cloudflare network[.]

**The unresolved ambiguity, stated plainly.** The CDN clause names the Developer Platform as one of the
*Paid* Services that exempt you from the picture restriction. Serving pet photos from R2 and Workers Static
Assets **on the free tier** is using the Developer Platform, but not a *Paid* Service. Cloudflare has published
no reconciliation of the two documents.

The defensible reading is that the CDN clause targets the classic abuse it was written for — pointing the free
CDN at an origin full of images and using Cloudflare as free image bandwidth — and that R2 plus Workers Static
Assets is the sanctioned path, which is exactly what the Developer Platform terms say the platform is for.
Pawster's photos would be first-party content, stored in and served from Cloudflare's own storage product, on
Pawster's own pages. That is not the hotlinking pattern.

It is still a residual risk, and the honest thing is to price it: **$5/month for Workers Paid removes the
question entirely**, because the Developer Platform then unambiguously is a Paid Service. That is the cheapest
insurance premium in this document, and it is the one thing worth spending money on if the free reading ever
looks shaky.

There is **no commercial-use restriction on the free plan.** Section 2.6 says only that Cloudflare offers Free
Services "from time to time", disclaims liability for them, and may discontinue them at its discretion. The
restrictions that do apply (2.2.1) are about resale and abuse, and three of them are worth recording because
they touch Pawster's design:

> (a) rent, lease, loan, export, or sell access to the Services to any third party, or **sign up for the
> Services on behalf of a third party**

Pawster signs up as itself. Shelters are Pawster's users, not Cloudflare's customers, and Pawster is not
reselling Cloudflare. This is a resale clause, and it reads much more narrowly than Vercel's
"benefit of a third-party" phrasing.

> (h) process or collect personal or business credit card information on any web property that is receiving
> Free Services

**Binding design constraint**: no card fields, ever, while on the free plan. Donations and adoption fees must
live off-platform behind an external link. This aligns with the map's existing "listing-only adoption flow,
contact leaves the platform" decision, so it costs nothing — but it must be written into the ADR, because it
is the one thing that would force an upgrade for a reason other than volume.

> (j) use the Services to provide a virtual private network or other similar proxy services

Not applicable, noted for completeness. Acceptable Use (2.7) is the ordinary illegality/IP/abuse list.

### Workers Free limits

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/):

| Limit | Workers Free | Workers Paid ($5/mo) |
| --- | --- | --- |
| Requests | **100,000 / day** | No limit |
| **CPU time per HTTP request** | **10 ms** | 5 min (default 30 s) |
| **CPU time per Cron Trigger** | **10 ms** | 30 s (< 1 h interval), 15 min (≥ 1 h interval) |
| Wall-clock duration | No limit | No limit |
| Memory per isolate | 128 MB | 128 MB |
| Worker size (compressed) | 3 MB | 10 MB |
| Workers per account | 100 | 500 |
| Subrequests per request | 50 | 10,000 |
| Cron Triggers | 5 per account (supported on Free) | 250 per account |
| Environment variables | 64 / Worker | 128 / Worker |
| Static asset files | 20,000 | 100,000 |

Two properties change the arithmetic entirely:

**Static assets are free and unlimited.** Per
[Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/):

> Requests to static assets are free and unlimited. Requests to the Worker script (for example, in the case of
> SSR content) are billed according to Workers pricing.

Every animal photo, every CSS and JS file, every prerendered page is off the meter and does not consume the
100,000/day. Only SSR and API hits count. For a photo-heavy listing site this is the single most valuable fact
in this document — it is the mirror image of Netlify charging 20 credits per GB of the same photos.

**Waiting on I/O does not count as CPU time.** Same limits page: "Waiting on network requests (such as
`fetch()` calls, KV reads, or database queries) does not count toward CPU time." The 10 ms is pure compute.

**Overage behaviour**: on Free, exceeding the daily request cap returns
[Error 1027](https://developers.cloudflare.com/workers/platform/limits/); depending on the route's
fail-open/fail-closed setting the Worker is bypassed or an error page is served. Per the pricing page, if you
exceed Free-plan limits "further operations of that type will fail with an error" — no automatic billing. No
card is required for Free; the tier does not expire. Cold starts are not a meaningful category on Workers'
isolate model in the way they are for container-based hosts.

### The one thing that hurts: 10 ms CPU

This is Cloudflare's binding constraint and it is not the one people expect. Not requests — 100,000/day is
enormous for a launch-stage shelter site. Not bandwidth — the photos are free. **10 ms of CPU per invocation,
and the same 10 ms applies to the Cron Trigger that runs the digest.**

Cloudflare's own limits page says how tight that is:

> Most Workers consume very little CPU time. The average Worker uses approximately 2.2 ms per request. Heavier
> workloads that handle authentication, **server-side rendering**, or parse large payloads typically use
> **10-20 ms**.

Cloudflare is telling you, in its own documentation, that SSR and authentication — two of the three things
Pawster needs a server for — land at or above the free cap. Take this seriously; it is not a theoretical
ceiling.

Consequences to design around, all of which the ADR should name:

- **Server-side rendering must be cheap.** A heavy React SSR pass on a long listing page will exceed 10 ms of
  compute. The listing must be prerendered as static assets (free, unlimited, and fast from Venezuela) with
  only genuinely dynamic bits — filtering, auth, form posts — going to the Worker.
- **The digest engine cannot be one big job.** 10 ms of compute will not render and send hundreds of emails in
  a single scheduled invocation. It has to fan out: the cron tick does almost nothing but enumerate work and
  dispatch, with per-subscriber rendering happening in separate short invocations. Since I/O wait is free,
  a job that is mostly "await the database, await the email API" fits comfortably; a job that is mostly
  template rendering in a loop does not.
- **That is a better digest design anyway.** Per-subscriber, idempotent, resumable, individually retryable —
  which is what the map wants the showcase subsystem to look like. The free tier is pushing the architecture
  in the direction it should already have gone. That is the argument for accepting the constraint rather than
  routing around it.
- **The escape valve is $5/month**, which raises CPU per cron invocation from 10 ms to 30 s — a 3,000x jump.
  If the digest ever genuinely cannot fit, the cost of being wrong is five dollars, not a re-platforming.

### Cloudflare's data and storage free tiers

Detail belongs to the storage/database ticket, but the hosting decision depends on these composing at $0, so
the headline numbers, all from Cloudflare's own pricing docs:

| Product | Free allowance |
| --- | --- |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | 5M rows read/day, **100,000 rows written/day**, 5 GB storage; no egress charge |
| [R2](https://developers.cloudflare.com/r2/pricing/) | 10 GB-month storage, 1M Class A ops, 10M Class B ops, **zero egress charges** |
| [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/) | 100,000 reads/day, **1,000 writes/day**, 1,000 deletes/day, 1 GB stored |
| [Images](https://developers.cloudflare.com/images/pricing/) | **5,000 unique transformations/month**; "You will not be charged for exceeding the limits in the Free plan" |
| [Pages builds](https://developers.cloudflare.com/pages/platform/limits/) | 500 builds/month, 1 concurrent, 20-minute build timeout |

Two footnotes that matter:

- **Workers KV's 1,000 writes/day is the tightest number in the whole Cloudflare stack.** Use KV for
  read-mostly config and caching only; anything that writes per-request or per-subscriber belongs in D1.
- **R2 requires a "subscription" checkout flow** to enable ([get started](https://developers.cloudflare.com/r2/get-started/):
  "Complete the checkout flow to add an R2 subscription to your account"), even though the tier itself is
  free. Whether that flow demands card details is **not stated on any Cloudflare page** — flag this as the one
  thing to confirm by actually clicking through, since the map forbids a card requirement. Workers Free itself
  has no such step.

Storing originals in R2 (free, zero egress) and transforming through Images Free gives roughly 5,000 unique
transformations a month; at three rendered sizes per photo that is about 1,600 new animal photos a month, with
repeat views free within the month. Comfortably above what Venezuelan shelters will publish at launch.

---

## Render — Hobby workspace + Free compute

Two things must both be free and they are billed separately: the **workspace plan** (Hobby, $0/month) and the
**compute plan** per service (Free, $0/month). Sources: [render.com/docs/free](https://render.com/docs/free),
[render.com/pricing](https://render.com/pricing),
[outbound bandwidth](https://render.com/docs/outbound-bandwidth).

| Limit | Free |
| --- | --- |
| Web service compute | 512 MB RAM, "Less than 1 CPU" |
| Instance hours | "750 Free instance hours to each workspace per calendar month"; spun-down time does not consume them |
| Outbound bandwidth (Hobby workspace) | 5 GB/month, then $0.15/GB |
| Build pipeline minutes | 500/month, then $5 per additional 1000 |
| Team members | 1 |
| Request timeout | **not documented** for free instances |

Spin-down, in Render's own words:

> Render spins down a Free web service that goes 15 minutes without receiving any inbound traffic. […] A Free
> web service spins back up whenever it next receives an HTTP request or new WebSocket connection. **This
> process takes about one minute.**

Render also states "Render might restart a Free web service at any time", and serves an automatic
`disallow: all` on `/robots.txt` while spun down — which quietly means **a spun-down Render free service asks
search engines not to index it.** For a site whose whole job is being findable by adopters, that is
disqualifying on its own, quite apart from the latency.

A one-minute cold start is not survivable for this product. A Venezuelan adopter on mobile data who taps a
shared listing link and gets a blank minute is gone, and so is the shelter's trust in the platform.

**Free Postgres expires.** Verbatim:

> Free Render Postgres databases expire **30 days after creation**. An expired Free database is inaccessible
> unless you upgrade it to a paid compute plan. After a Free database expires, you have a grace period of 14
> days to upgrade it […] After the grace period, Render deletes the database (along with all of its data).

Also: one per workspace, 1 GB fixed storage, 256 MB RAM, no backups of any kind, no managed connection
pooling. Cheapest paid Postgres is $6/month. This alone fails the map's "free tier that does not expire" rule.

**Terms**: no plan-based commercial restriction. [Render's ToS](https://render.com/terms) contemplates
commercial use ("If you are using the Service for commercial purposes…") and expressly provides for opening an
account "on behalf of a company, organization, or other entity". The
[AUP](https://render.com/acceptable-use) (last modified August 22, 2025) prohibits "**other unauthorized
commercial purposes**" — undefined, but sitting in a list about resale, crypto mining and payment evasion, so
it reads as an anti-resale clause rather than a ban on running your own app.

The pointed part is not legal but editorial. The docs say: "Free instances have important limitations […]
**Do not use them for production applications.**" It is not a contractual bar, but Render is telling you
plainly what the tier is for.

**Trigger to paid**: whichever comes first — needing no sleep (~$7/mo), Postgres hitting day 30 ($6/mo), 5 GB
egress, 500 build minutes, or a second always-on service (730 h each against a 750 h pool). Realistic $0
lifespan: 30 days, ended by the database.

**Verdict: rejected.** The database expires, the service sleeps for a minute, and while it sleeps it
de-indexes itself.

---

## Fly.io — no free tier exists

This is the finding most likely to catch someone out, because Fly's free allowances are still widely cited.
They were **discontinued on October 7, 2024** and are honoured only for pre-existing customers
([discontinued plans](https://fly.io/docs/about/discontinued-plans/)); new signups get pay-as-you-go only, and
"If you change your plan, you won't be able to return to the Hobby Plan."

What replaces it is a trial, and its real limit is not the seven days
([free trial](https://fly.io/docs/about/free-trial/)):

> A free trial on Fly.io includes **2 hours of machine runtime or 7 days of access, whichever comes first.**

Two VM-hours. An always-on app exhausts the trial in **two hours**, not a week. Trial machines also "are set
to automatically stop after running for 5 minutes." At the end: "your apps will stop running. You won't be
able to launch new machines, attach volumes, or deploy changes until billing is set up."

[Pricing](https://fly.io/docs/about/pricing/) states "All organizations (except for Linked Organizations)
require a credit card on file", and adding a card "ends the free trial". Cheapest always-on VM
(shared-cpu-1x, 256 MB) is ~$2.02/month. Egress to South America is **$0.04/GB** — double the
North America/Europe rate, which is the wrong direction for a Venezuelan audience. Managed Postgres starts at
**$38/month**; the ~$2/month self-run option is labelled by Fly's own pricing page as "Unmanaged Fly Postgres
(Unsupported)".

Autostop/autostart is genuine and free, but **Fly publishes no wake-latency figure at all** — the only
comparative statement in its docs is that suspended starts faster than stopped. Any specific millisecond
number in circulation is not vendor-sourced.

**Terms**: [Fly's ToS](https://fly.io/legal/terms-of-service/) is silent on commercial use — it is a B2B
contract where business use is the assumed case. It does carry the same third-party clause family as Vercel:
Customer will not "sublicense any of Customer's rights under this Agreement, **or otherwise use the Fly.io
Services for the benefit of a third party**."

**Verdict: rejected.** Fails the $0 constraint outright.

---

## Railway — Free plan exists, but is funded by $1/month

Railway removed the old free tier and later added a different one. Four things exist today
([pricing](https://railway.com/pricing),
[plans](https://docs.railway.com/reference/pricing/plans),
[free trial](https://docs.railway.com/reference/pricing/free-trial)):

| | Price | Credits | Per-service ceiling |
| --- | --- | --- | --- |
| Trial | $0 | one-time $5, expires in 30 days | 2 replicas, 1 GB RAM, 2 vCPU, 0.5 GB volume |
| **Free** | **$0/month** | **$1 of free credit per month**, does not roll over | 1 replica, 0.5 GB RAM, 1 vCPU, 0.5 GB volume |
| Hobby | $5/month | $5 usage credits | 6 replicas, 48 GB RAM |
| Pro | $20/month | $20 usage | 42 replicas |

> After 30 days passes or $5 is spent, the free trial reverts to the Free plan, which provides $1 of free
> credit per month. The credit does not roll over month to month.

So a $0/month indefinite plan does exist — but it is a **$1 credit against usage-based pricing**, not an
allocation of compute. Rates are RAM $10/GB/month, CPU $20/vCPU/month, egress $0.05/GB, volumes
$0.15/GB/month. A small always-on service using ~250 MB plus some CPU runs roughly $2.50–3/month, so $1
covers somewhere around a third of a month (this arithmetic is derived, not published by Railway). The
documented consequence is not:

> If you are using credits as a payment method and your credit balance reaches zero, your subscription will be
> cancelled. You will no longer be able to deploy to Railway and **we will stop all of your workloads**.

Sleeping is opt-in (Serverless), inactivity detected after ~5 minutes of no outbound traffic, "in practice
somewhere between 5 and 10 minutes". No wake-latency figure is published, and there is a documented failure
mode: "**The first request sent to a slept service may return a 502 Bad Gateway response.**"

No credit card required for Trial or Free. Unverified accounts get a **Limited Trial** with "restricted
outbound network access" — verification is automated via GitHub account age/activity and "Railway does not
respond to requests for verification", which is a real risk for a fresh project account.

**Terms**: the only explicitly on-point commercial clause in this survey, and it cuts both ways
([terms](https://railway.com/legal/terms)):

> You will only use the Services for **your own internal, personal, and/or business use, and not on behalf of
> or for the benefit of any third party**[.]

Business use is expressly permitted on any plan with no free carve-out — better than Vercel. But
"for the benefit of any third party" is expressly prohibited, and Pawster's purpose is publishing third-party
organisations' listings. Organisational signup is provided for, so the clean reading is that the account
holder must be the entity operating the platform. The [AUP](https://railway.com/legal/acceptable-use) bans
resale, proxying, and "evading usage or billing limits" — the last one closing off cycling trial accounts.

**Verdict: rejected.** $1/month is not a free tier for anything always-on, and the failure mode is all
workloads stopped.

---

## Deno Deploy — Free plan

### The friendliest terms in the survey, by a distance

Deno is the only vendor here that says in writing what you are allowed to build. From the
[Acceptable Use Policy](https://docs.deno.com/deploy/acceptable_use_policy/) (last updated October 7, 2025):

> **Examples of Acceptable Use**
> ✅ Server-side rendered websites · ✅ Jamstack sites and apps · ✅ Single page applications ·
> ✅ APIs that query a DB or external API · ✅ A personal blog · ✅ **A company website** ·
> ✅ **An e-commerce site** · ✅ Reverse proxy
>
> **Not Acceptable Use**
> ❌ Crypto mining · ❌ Highly CPU-intensive load (e.g. machine learning) ·
> ❌ **Media hosting for external sites** · ❌ Scrapers · ❌ Forward proxy · ❌ VPN

"A company website" and "An e-commerce site" are explicitly green-lit, with no free-versus-paid distinction
anywhere in the policy. "Media hosting for external sites" does not reach Pawster — the photos are served on
Pawster's own pages, not as a media host for other people's sites.

The [Terms and Conditions](https://docs.deno.com/deploy/terms_and_conditions/) grant use "solely for your
**internal business purposes**", standard SaaS boilerplate that contemplates business use. One clause in those
terms looks alarming and is not: a prohibition on using "the Content […] for any public or commercial purpose"
sits in a paragraph about Deno's *own* site materials and trademarks. It does not restrict your application.
Do not misread it.

The pricing page tagline says "For personal use and smaller projects" — marketing copy, flatly contradicted by
the AUP, and not incorporated into the Terms.

### Free plan limits

From [deno.com/deploy/pricing](https://deno.com/deploy/pricing):

| Metric | Free | Pro ($20/mo) |
| --- | --- | --- |
| Requests | **1M / month** | 5M |
| **Egress bandwidth** | **20 GiB / month** | 200 GiB |
| Active CPU | 10 hr/month (aggregate, **no per-request cap**) | 50 hr |
| Memory time | 150 GiB-hr | 750 GiB-hr |
| Apps | 10 | 50 |
| Builds | 15/hour, 1 concurrent | 60/hour, 3 concurrent |
| Custom domains | 5 | 100 |
| Team members | 3 | 10 |
| Logs & traces retention | 1 day | 1 week |
| Deno KV | 1 GiB stored, 1M read units/mo, **500k write units/mo** | 5 GiB, 5M, 2.5M |

Deno bills active CPU only: "CPU isn't consumed while your app is waiting for incoming requests or blocked on
network I/O." Idle apps "automatically shut down after ~20-30 seconds".

Technical limits from [pricing and limits](https://docs.deno.com/deploy/pricing_and_limits/): deployment size
"should not exceed 1 gigabyte", max memory allocation "512MB" — note this **contradicts** the pricing page's
"768 MB of memory for each second your app is loaded in memory". Two vendor pages, two numbers, unresolved.
Request lifetime is an idle timeout "between 5 seconds and 10 minutes"
([runtime reference](https://docs.deno.com/deploy/reference/runtime/)).

**Cold starts are real but fast**: "Cold starts in Deno Deploy are highly optimized and complete within 100
milliseconds for hello world applications, and within a few hundred milliseconds for larger applications."
Combined with the 20-30 second idle shutdown, a low-traffic shelter site will cold-start often — but a few
hundred milliseconds is a non-event next to Render's minute.

### Where Deno beats Cloudflare, and where it loses

Deno wins on the two things that make Cloudflare awkward:

- **No per-invocation CPU cap.** 10 CPU-hours a month in aggregate, so an SSR render or a digest batch that
  needs 200 ms of compute is simply fine. No fan-out gymnastics required.
- **Deno KV allows ~16,000 writes/day equivalent** (500k/month) against Workers KV's 1,000/day.

It loses on the one that matters most for this product:

- **20 GiB/month of egress, and static assets count against it.** Roughly 20,000 page views at 1 MB of animal
  photos each. That is a reachable number for one modestly successful shelter's Instagram post, and the whole
  business of this site is photographs. Cloudflare does not meter egress at all and R2 charges zero for it.
- **Only 10 apps and 5 custom domains**, and 1-day log retention.

### The gaps in Deno's documentation

**What happens when you exceed a free limit is not documented anywhere.** No error code, no throttling curve,
no statement of hard-stop versus auto-bill. The closest page,
[usage guidelines](https://docs.deno.com/deploy/usage/), promises configurable spend limits "Before October 1st
2025" — a date now eleven months stale. The AUP offers only "We will reach out to you where possible before
taking any action". For a $0 constraint that must not turn into a bill, an undocumented overage behaviour is
itself a risk. Cloudflare, by contrast, documents Error 1027, the 429, and fail-open versus fail-closed.

Also: **Deno Deploy Classic is closed.** "We are no longer onboarding new users or organizations to Deploy
Classic", with shutdown announced for July 20, 2026 — a date already past
([classic docs](https://docs.deno.com/deploy/classic/), still written in future tense, i.e. stale). Only the
current generation is available, so the Classic-vs-new limits comparison the ticket asked for is moot.

**Verdict: strong runner-up.** Best terms in the survey, no CPU cliff, real cold starts but small ones. Loses
on metered egress for a photo site and on undocumented overage behaviour.

---

## Aside: GitHub Pages, and how narrow a sane commercial clause looks

Not in the ticket's list and not viable — Pages is static-only, so it cannot host the digest engine, the
shelter auth, or any server-side rendering — but it is a useful calibration point for what a *reasonable*
commercial restriction reads like. From
[GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
the prohibition is on using Pages as a "free web-hosting service to run your online business", an
"e-commerce site, or any other website that is primarily directed at either facilitating commercial
transactions", or "providing commercial software as a service (SaaS)". A non-profit adoption listing
facilitates no transaction and is plainly fine.

Its limits: source repo "recommended limit of 1 GB", published site "no larger than 1 GB", "soft bandwidth
limit of 100 GB per month", "soft limit of 10 builds per hour".

The contrast with Vercel is the point. GitHub bans commerce; Vercel bans *money existing anywhere near the
project*, donations included. Two clauses that both say "commercial" and mean entirely different things — which
is why this had to be read rather than assumed.

---

## Comparison

| | Perpetual $0? | Card? | Commercial / non-profit use permitted? | Single binding free limit | Failure mode |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Workers** | Yes | No (but R2 needs a "subscription" checkout — unverified) | **Yes** — terms silent; no personal-use clause | **10 ms CPU per invocation** (HTTP and cron alike) | Error 1027 / 429; never auto-billed |
| **Deno Deploy** | Yes | Unverified | **Yes, explicitly** — AUP green-lights company and e-commerce sites | **20 GiB/month egress** | Undocumented |
| **Netlify** | Yes | No | Yes — terms silent on commercial use | **300 credits/month ≈ 20 production deploys or 15 GB** | All projects paused, account-wide |
| **Vercel** | Yes | No | **No** — "non-commercial personal use only"; donations count as commercial | Commercial-use clause, before any number | Deployment paused without notice |
| **Render** | Compute yes, **Postgres no** | No | Yes, though docs say "Do not use them for production applications" | **Free Postgres expires 30 days after creation** | DB inaccessible, then deleted after 14-day grace |
| **Railway** | Technically | No | Business use yes; "for the benefit of any third party" **prohibited** | **$1/month of credit** (~a third of a month always-on) | All workloads stopped |
| **Fly.io** | **No** | Yes, to continue | Silent (B2B contract) | **2 VM-hours of trial, total** | Apps stop |

---

## Recommendation

**Cloudflare Workers, with Workers Static Assets for the listing pages, D1 for data and R2 for photos.**
Keep the $5/month Workers Paid plan as a named, budgeted escape hatch rather than pretending it will never be
needed.

The reasoning has three parts, in order of how much they should count.

**First, terms.** This decision is not primarily about limits, because the ticket is right that getting the
terms wrong costs a takedown rather than a bill. On terms the field splits cleanly. Vercel forbids what Pawster
is, in writing, with donations named explicitly — and a non-profit that can never put a donate link on its own
site is a non-profit hosting itself on a platform that has told it to leave. Railway forbids use "for the
benefit of any third party", which is a fair description of a listings platform. Fly carries the same
third-party clause. Cloudflare, Netlify, Render and Deno are all safe: Cloudflare and Netlify because their
self-serve agreements are silent on commercial use, Deno because its AUP affirmatively blesses company and
e-commerce sites. Silence is the right outcome here — it means the vendor never contemplated restricting you.

**Second, the shape of the workload.** Pawster is a photo-heavy read-mostly site with a scheduled job. On
Cloudflare, static asset requests are "free and unlimited" and R2 egress is zero-rated, so the single largest
resource this product consumes — animal photographs — is entirely off the meter. Every other candidate charges
for exactly that: Netlify at 20 credits per GB, Deno against a 20 GiB monthly cap, Render against 5 GB, Fly at
$0.04/GB to South America. This is not a marginal difference. It is the difference between a free tier that
scales with the product's success and one that punishes it.

**Third, the failure mode when a limit is hit.** Cloudflare documents it: Error 1027, a 429, fail-open or
fail-closed by route, and explicitly no charge. Netlify pauses every project on the account. Railway stops all
workloads. Render deletes the database. Deno does not document it at all. For a solo maintainer who will not
be watching dashboards, a documented, non-billing, per-route degradation is worth a great deal.

**Deno Deploy is the runner-up and deserves to be recorded as such.** It has the best terms of anyone here and
no per-invocation CPU cap, which makes it materially easier to build on. If the 10 ms CPU limit turns out to be
more painful in practice than this document predicts, Deno is where to go — not Vercel, not Netlify. The reason
it does not win is the 20 GiB egress ceiling on a photo site, plus undocumented overage behaviour.

### What accepting this costs, stated honestly

- **10 ms of CPU per invocation, cron included.** Cloudflare's own docs put SSR at 10-20 ms. The listing must
  be prerendered to static assets and the Worker reserved for genuinely dynamic work. The digest engine must
  fan out into short per-subscriber invocations rather than running as one batch. Both constraints improve the
  design — a prerendered listing is faster from Venezuela anyway, and a per-subscriber, idempotent, resumable
  digest is exactly the showcase subsystem the map wants — but they are constraints, and the ADR must name
  them rather than discover them mid-build.
- **1,000 Workers KV writes/day.** KV is for read-mostly config and cache only. Anything per-request or
  per-subscriber goes in D1.
- **No card fields on the site, ever, while on the free plan** (SSA §2.2.1(h)). Donations and adoption fees
  must be external links. This matches the map's existing listing-only decision at zero cost, but it must be
  written down, because it is the one thing that would force an upgrade for a non-volume reason.
- **A residual reading risk on the CDN "disproportionate percentage of pictures" clause**, unresolved between
  two Cloudflare documents.

### The triggers that would force paid, in likelihood order

1. **SSR or auth exceeding 10 ms CPU** in a way prerendering cannot fix → Workers Paid, $5/month, raises the
   cap to 30 s (5 min for HTTP) and 30 s–15 min for cron.
2. **The digest outgrowing 10 ms per invocation** even fanned out → same $5.
3. **Wanting the CDN photo clause to be unambiguous** → same $5, which makes the Developer Platform a Paid
   Service by definition.
4. **100,000 Worker invocations/day** (static assets excluded, so this is far away).
5. **1,000 KV writes/day** or **100,000 D1 rows written/day**.

The whole escape ladder is five dollars a month, and the first rung buys away three of the five risks at once.
That is the real argument for Cloudflare: not that it is free, but that being wrong about it is cheap and
recoverable, whereas being wrong about Vercel is a takedown and being wrong about Render is a deleted database.

---

## Answers to the ticket's specific questions

**"Establish what 'commercial' means in Vercel's and Netlify's current terms for a site that hosts other
organisations' listings."**

They mean opposite things, which is why this had to be read rather than assumed.

*Vercel* defines it maximally: any deployment "used for the purpose of financial gain of **anyone** involved in
**any part of the production** of the project", with donations explicitly included. A non-profit is not exempt
— "non-commercial" is about money, not about profit motive. Pawster on Hobby would be a violation the moment it
accepts a donation, links to a shelter's donation page in a way that reads as solicitation, or pays anyone to
work on it. Vercel's Terms additionally forbid using the Services "for the benefit of a third-party", which a
literal reader could apply to a platform whose purpose is publishing shelters' listings. Enforcement is a pause
without notice. **If Vercel is ever reconsidered, get a written answer from Vercel Support first — their own
docs tell you to ask.**

*Netlify* has no commercial-use restriction at all. Three documents were checked (Self-Serve Subscription
Agreement, Website Terms of Use, Acceptable Use Policy) and none distinguishes personal from commercial use.
The AUP's "commercially exploit the Netlify Services" is an anti-resale clause. Netlify is legally fine for
Pawster and fails on allowance instead.

**"Whether the tier expires or requires a card."** No card on Vercel Hobby, Netlify Free, Cloudflare Workers
Free, Render Free, or Railway Free/Trial. Fly requires one to continue past the trial. Card status for Deno
Deploy signup and for Cloudflare's R2 subscription checkout could not be established from any vendor page and
should be confirmed by clicking through. Only Fly (7-day trial), Railway's $5 trial credit, and Render's free
Postgres (30 days) expire.

---

## Open questions this research could not close

1. **Does enabling R2 require card details?** Cloudflare says "complete the checkout flow to add an R2
   subscription" without stating what the flow asks for. Confirm by clicking through before committing.
2. **Does Deno Deploy signup require a card?** No vendor page addresses it.
3. **What does Deno Deploy do when a free limit is exceeded?** Undocumented.
4. **Does the CDN "disproportionate percentage of pictures" clause reach a free-tier R2 + Workers Static
   Assets site?** The two Cloudflare documents are not reconciled in writing. $5/month makes it moot.
5. **Deno's 512 MB versus 768 MB memory contradiction** between two of its own pages.
6. **Render's per-request timeout on free instances** is not documented.
7. **Fly publishes no wake-latency figure**, in any unit.

---

## Method note

Every figure and quotation above was taken from the vendor's own docs, pricing, or legal pages, fetched
2026-09-01. No blog posts, comparison sites or forum answers were used as sources for any claim. Three of this
document's most load-bearing findings — Netlify's move to credit-based pricing on 2025-09-04, Fly's
discontinuation of free allowances on 2024-10-07, and the relocation of Cloudflare's non-HTML content clause
into the Service-Specific Terms — are each less than two years old and each contradict widely repeated advice.
Anything in this document should be re-checked against the source before an ADR is finalised on it.
