# The domain is free, and it lives outside Cloudflare

The map's standing preferences allowed exactly one expense: *"a domain name is the only accepted cost."* That allowance is **withdrawn**. Pawster buys nothing, and `$0` is now absolute rather than nearly-absolute.

An earlier draft of this ADR read that as a loss to be absorbed, and concluded that **"email needs a domain, and there is no substitute"** — so Pawster would run on generated hostnames and mail only its own operator until someone eventually paid. That conclusion was wrong, and it was wrong in a way worth recording, because it came from treating "domain" as one indivisible requirement.

It is two requirements, and they fail for different reasons.

## The chain that made a domain load-bearing, and where it breaks

[ADR 0011](0011-r2-custom-domain-requires-a-full-zone.md) built a chain: [ADR 0007](0007-prerender-first-and-filter-in-the-browser.md) needs images CDN-cached and Worker-free → that needs an **R2 custom domain** → which needs *"a zone in the same account as the R2 bucket"* → which, since partial setups are Business-plan-only, needs a **full nameserver delegation** → which needs a domain. Email then rode along on the same zone, because Resend's `MX`, SPF and DKIM records had to be published somewhere.

Both loads come off that chain.

**Images do not need a zone.** Cloudflare has two distinct caching features, and the earlier draft rejected the Worker route by reasoning about the wrong one. The legacy **Cache API** is genuinely inert on a generated hostname — *"any `*.workers.dev` deployments will have no impact"* — which is what made "serve images through a Worker to obtain caching" look like a trade of a 10M/month meter for a 100k/day one. But **Workers Cache** is a separate, opt-in, zone-independent feature: a Worker *"can be bound to any number of zones, run on `workers.dev`, or be invoked entirely through service bindings without ever touching a zone."* Enabled with `{"cache": {"enabled": true}}` and driven by ordinary `Cache-Control`, it gives cached image delivery with no custom domain and no zone at all.

**Email needs DNS, but not *Cloudflare's* DNS.** Resend documents no restriction on which domains may be verified — no registrable-apex rule, no free-suffix blocklist, no minimum age, no manual review — and it *recommends* a subdomain: *"send your emails from one or more subdomains… to isolate your sending reputation."* Any nameserver that can publish the records will do. Cloudflare was only ever the incumbent because ADR 0011's chain had already put the zone there.

So the requirement was never "own a domain". It was "control DNS somewhere, for email".

## What a free zone actually costs

Cloudflare's test for admitting a zone on the Free plan is **Public Suffix List membership**, and nothing else. A clean natural experiment settles it: one user, one day, two DigitalPlat suffixes — `qzz.io` (on the PSL) added successfully, `qd.je` (absent) refused with error 1099, *"root domain and not any subdomains"*. `eu.org`, `dpdns.org`, `qzz.io` and `us.kg` are all present in the list's `PRIVATE DOMAINS` section, verified directly against `public_suffix_list.dat` rather than inferred; `pages.dev`, `r2.dev` and `workers.dev` sit there too, three lines apart.

That means a free subdomain *can* be a full Cloudflare zone. **We are not going to make it one.**

Cloudflare Trust & Safety has suspended **accounts** over `*.dpdns.org` during 2025–26, and PSL maintainers recorded VirusTotal malicious detections across all four DigitalPlat suffixes while rejecting a fifth. A suspended domain is an inconvenience; a suspended *account* takes R2, D1, Queues and Workers with it — the entire platform [ADR 0006](0006-cloudflare-as-the-single-platform.md) deliberately consolidated onto one vendor. Attaching a shared-abuse suffix to that account concentrates a tail risk directly onto the single point of failure ADR 0006 already accepted.

Since images no longer need the zone, there is no reason to run it. **The free domain is delegated to a nameserver that is not Cloudflare** — DigitalPlat's own tutorial names deSEC alongside Cloudflare, Vercel and Netlify — and Pawster's Cloudflare account never learns the suffix exists.

## The decision

- **Register `pawster.dpdns.org`.** Free, self-service, no card, and its PSL entry has been synced since April 2025.
- **Delegate it to deSEC**, not to Cloudflare. DigitalPlat provides no DNS record editor at all — delegation is its only mode — so an external nameserver is required regardless; the choice is only *which*, and choosing not-Cloudflare is free.
- **Verify the Resend sending subdomain against deSEC.** Full record-type freedom, and self-service rotation on demand.
- **Serve images from `r2.dev` now, and from a cached Worker when volume justifies it.** No R2 custom domain, now or later.
- **Lodge a `pawster.eu.org` application in parallel.** It costs nothing but a form, its abuse neighbourhood is materially cleaner, and if it is granted in one to three months it becomes a drop-in replacement. If it never arrives, nothing was waiting on it.

## Consequences

- **The digest reaches real subscribers.** This is the whole point of the reversal. The earlier draft's conclusion — operator-only mail, the map's thin slice losing its third leg — does not happen. Shelter sign-in codes ([ADR 0013](0013-shelters-sign-in-with-an-emailed-code.md)), admin verification links ([ADR 0002](0002-no-admin-accounts.md)), confirmation capabilities ([ADR 0008](0008-confirmation-is-a-capability-not-a-session.md)) and the digest ([ADR 0009](0009-digest-delivery-and-retry.md)) all work for arbitrary inboxes.
- **[ADR 0011](0011-r2-custom-domain-requires-a-full-zone.md) is superseded, and its central claim is now moot rather than wrong.** Its reasoning about partial setups being Business-plan-gated remains correct and is worth keeping; what changes is that Pawster no longer wants an R2 custom domain, so the constraint binds nothing. Cloudflare is **not** the DNS authority for Pawster; deSEC is, and Cloudflare holds no zone at all.
- **Leaving Cloudflare got cheaper, not dearer.** ADR 0011 observed that its decision added a nameserver cutover to any migration. That is now untrue: DNS was never moved in, so an exit is once again a compute-and-storage migration only.
- **Deliverability is a reasoned expectation, not a measured fact, and this is the weakest joint in the decision.** No per-suffix inbox-placement measurement exists for `dpdns.org`, for `eu.org`, or for any free suffix; Gmail's, Yahoo's and Microsoft's published sender requirements name no TLD or suffix at all, and the widely-repeated claim that providers blocklist free domains has no primary source behind it. Two documented mechanisms could still pool our reputation with the suffix's neighbours — Google Postmaster Tools reports on *"primary domains only, not to subdomains"* without ever defining "primary domain" or referencing the PSL, and Spamhaus DBL lists *"at the main domain level"* so that all subdomains inherit the listing. Whether either resolves `pawster.dpdns.org` to itself or to `dpdns.org` **cannot be determined from public sources**. One cheap observation settles it for our case: enrol in Google Postmaster Tools and read which domain it reports under. Do that before the first real digest, not after.
- **DMARC, at least, is favourable and documented.** Validators consult the PSL to find the organizational domain and *"intermediate subdomains are skipped entirely"*, so `pawster.dpdns.org` is its own organizational domain and inherits no policy from `dpdns.org`.
- **The binding risk is behavioural, not the suffix.** Resend's acceptable-use thresholds are a complaint rate under 0.08% and bounces under 4% — one complaint per 1,250 emails breaches the first. At Pawster's scale that is a handful of annoyed recipients, which makes [ADR 0010](0010-subscriber-data-retention.md)'s `Do-Not-Contact` machinery and a working unsubscribe more load-bearing than any DNS decision here.
- **`r2.dev` is worse than the earlier draft allowed, and it is now the interim image path.** Cloudflare's documented position is *"rate-limited and should only be used for development purposes"*, with the only published figure a range — throttling with `429` above *"hundreds of requests/second"* — plus bandwidth throttling and no caching, WAF or bot management. The 10M Class B ops/month allowance still means this costs latency rather than money, but the rate limit is a real cliff with no published threshold, and it is the trigger to build the cached Worker.
- **Two vendors were added to a deliberately one-vendor stack.** ADR 0006 chose Cloudflare as the single platform; DigitalPlat and deSEC are now in the critical path for email. Both are free, neither holds data, and both are replaceable — but a DigitalPlat outage or shutdown takes the sending domain with it, which is a failure mode Pawster did not previously have. The `eu.org` application is the hedge.
- **Telegram is the fallback if email disappoints**, and it is a genuine one: free, push, domain-free, and it accepts a webhook on a `workers.dev` origin. It is recorded as a fallback rather than chosen, because it trades an address every adopter already has for an app not every adopter has.

## What was rejected

- **Buying a domain.** Declined outright; this ADR exists because of that.
- **Making the free suffix a Cloudflare zone.** Mechanically available and would restore the R2 custom domain, but it points a documented account-suspension risk at the single platform ADR 0006 consolidated onto, to buy caching that Workers Cache now provides for nothing.
- **Waiting for `eu.org` before shipping.** Approval runs one to three months, with year-old applications still unapproved. Applied for, not waited on.
- **`is-a.dev`.** On the PSL, but its FAQ refuses `NS` delegation *"via Cloudflare or deSEC"* and its maintainer states it will stay maintainer-only over abuse risk. Its `MX`/`TXT` support would serve Resend, but every record change is a pull request against a very busy repository, with no documented turnaround — unacceptable for a key that may need emergency rotation.
- **`js.org`** — `CNAME`-only, and new subdomain requests are paused until mid-September 2026.
- **WhatsApp** as the digest channel. Since 1 July 2025 Meta charges per message and *"all marketing template messages are charged"*; a weekly digest is a marketing template every week, per recipient. There is no $0 configuration.
- **Sending as a free-webmail address through a third-party ESP.** Unchanged from the earlier draft: it fails DMARC alignment for a domain we do not control, producing mail that is sent but not delivered — a silent failure, which is the worst kind.
