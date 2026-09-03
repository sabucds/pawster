# Cloudflare is the DNS authority, because R2's custom domain leaves no alternative

> **Superseded by [ADR 0014](0014-the-domain-is-free-and-lives-outside-cloudflare.md).**
> The reasoning below is still correct — a partial (CNAME) setup really is
> Business-plan-gated, so a full nameserver delegation really is the only route
> to an R2 custom domain on Free. What changed is that Pawster **no longer wants
> an R2 custom domain**: Workers Cache is zone-independent and caches on
> `workers.dev`, so the chain this ADR builds no longer has anything hanging off
> it. Cloudflare holds **no zone** for Pawster and is **not** its DNS authority;
> the sending domain is delegated to deSEC instead. Read this one for why the
> constraint exists, not for what Pawster does.

ADR 0007 makes the R2 custom domain load-bearing: adopters browse a static listing whose photos and filter index are read straight from R2, so those reads must be CDN-cached and must not invoke a Worker. Cloudflare requires a custom domain for that — `r2.dev` is explicitly not cached, which would turn every image view into a billable Class B `GetObject` — and a custom domain requires *"a zone in the same account as the R2 bucket."*

The image-storage research (issue #5) recorded that this could be satisfied by a **partial (CNAME) setup**, keeping the domain's nameservers at its registrar and delegating only the R2 hostname to Cloudflare. That was appealing because it keeps DNS portable. **It is not available to us.** Cloudflare's DNS documentation states that *"a CNAME setup (partial) is only available to customers on a Business or Enterprise plan"*, and tabulates Free and Pro as `No`. The cheapest plan that unlocks it costs more per month than this project's entire intended lifetime spend.

So the zone is a **full setup**: the domain's nameservers are delegated to Cloudflare, and Cloudflare is authoritative for all of Pawster's DNS. Registering the domain at Cloudflare Registrar creates it that way outright, which is also the cheapest place to buy it, since Registrar sells at wholesale cost with no markup.

This is a decision rather than a mere constraint because it is where the single-vendor posture of ADR 0006 stops being reversible in one place and becomes reversible only in two: leaving Cloudflare now means moving DNS as well as compute.

## Consequences

- **Cloudflare holds DNS for the whole domain, not just the image hostname.** Every record Pawster needs — Resend's DKIM, SPF and bounce MX among them — is created in the Cloudflare zone. There is no split-brain DNS to reason about, which is a simplification, but the blast radius of a Cloudflare account problem now includes email deliverability and not just the website.
- **A migration away from Cloudflare acquires a DNS cutover.** It was already a compute and storage migration; it is now also a nameserver change, with the propagation delay that implies. This does not change the escape hatch ADR 0006 names — the $5/month Workers Paid plan is still one click, still inside Cloudflare — but it does raise the cost of the exit nobody is planning.
- **Records added for third parties must be `DNS only`.** Cloudflare proxies by default, and a proxied DKIM record does not verify. This is the single most likely provisioning mistake, so `scripts/provision.sh` warns about it at the point of entry rather than leaving it to be discovered through failed sends.
- **The domain must be bought before anything else is provisioned**, because the bucket's custom domain cannot attach until the zone is active. That ordering is why it is the first stage of the provisioning wizard, and delegation can take hours.
- No cost is actually incurred by this, because the domain is bought fresh for Pawster and has no existing DNS to migrate. The constraint would have been genuinely expensive had we been attaching an established domain whose nameservers could not move.
- The partial-setup claim in `docs/research/free-tier-image-storage.md` is corrected in place rather than deleted, so that a future session reading the research does not re-derive the wrong plan. The rest of that section's conclusion — custom domain, never `r2.dev` — stands.
