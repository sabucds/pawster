# pawster

A mobile-first web app where Venezuelan animal shelters publish animals for
adoption, adopters browse and filter them, and adopters subscribe to periodical
email digests of animals matching their criteria.

Design decisions live in [`docs/adr/`](docs/adr/); the glossary is in
[`CONTEXT.md`](CONTEXT.md). Planning is charted on
[issue #1](https://github.com/sabucds/pawster/issues/1).

## Layout

An npm-workspaces monorepo of four packages, the split
[ADR 0007](docs/adr/0007-prerender-first-and-filter-in-the-browser.md) asks for.

| Package | What it is |
|---|---|
| [`web/`](web/) | The Astro Worker. Prerender-first: `export const prerender = false` is the exception, and every route that carries it is a decision. |
| [`digest/`](digest/) | The digest Worker — a `scheduled` producer and a `queue` consumer, including the dead-letter queue's. |
| [`db/`](db/) | The Drizzle schema and the migrations. Both Workers bind the same D1 database and share these migrations. |
| [`domain/`](domain/) | Pure. No I/O, no `db/` import, no dependencies at all — which is what makes it free to test. |

Two Workers rather than one so each gets its own 3 MB bundle and 10 ms CPU budget, deploys
independently, and — the reason that matters — so the digest engine can be tested without
booting Astro.

```sh
npm install           # wires all four workspaces
npm test              # every workspace, plus the structural source rules
npm run typecheck
npm run build         # Astro build for web/
npm run deploy:dry-run   # both Workers; neither is deployed
```

The suite runs against a real `workerd` isolate and a real local D1 with the real
migrations applied, **with no network and no credentials**. How that works, and the two
things it deliberately cannot catch, are in
[`docs/testing-seams.md`](docs/testing-seams.md). The two numbers ADR 0007 says must be
measured rather than assumed are recorded in
[`docs/measurements.md`](docs/measurements.md).

## Provisioning

The third-party accounts and the Cloudflare resources are provisioned by an
interactive wizard:

```sh
./scripts/provision.sh
```

It walks you through every registrar and dashboard action, creates the D1
database, both R2 buckets and both Queues over the Cloudflare CLI, writes the
captured values to `.env` and the CI secrets to GitHub, and finishes by writing
`docs/provisioning-record.md`. It is safe to re-run: values already in `.env`
are offered as defaults, and the one secret that must never rotate — the
Do-Not-Contact pepper of [ADR 0010](docs/adr/0010-subscriber-data-retention.md)
— is never regenerated once present.

Two of each, because two ADRs ask for a pair rather than a single resource:

- **A second R2 bucket for originals**, never public, under a 7-day expiry
  lifecycle rule ([ADR 0012](docs/adr/0012-derivatives-are-generated-once-at-upload.md)).
  Neither bucket gets a custom domain (see below), but the reason this one must
  never be public at all is different and permanent: a retained original still
  carries the EXIF the derivatives strip.
- **A dead-letter queue** beside the digest queue
  ([ADR 0009](docs/adr/0009-digest-delivery-and-retry.md)): its consumer is what
  pings the Healthchecks `/fail` endpoint, so it has to exist as a real queue
  before the digest Worker can name it.

### The domain

Pawster buys nothing, so the domain is a free subdomain, and a second wizard
acquires it:

```sh
./scripts/provision-domain.sh
```

Seven stages: register `pawster.dpdns.org`, delegate it to **deSEC**, verify
the Resend sending subdomain against it, and lodge a `pawster.eu.org`
application as a free hedge.

The two properties worth knowing before you run it, both from
[ADR 0014](docs/adr/0014-the-domain-is-free-and-lives-outside-cloudflare.md):

- **The domain never touches Cloudflare.** It could — Cloudflare admits any
  zone whose suffix is on the Public Suffix List, and `dpdns.org` qualifies —
  but Cloudflare Trust & Safety has suspended *accounts* over that suffix, and
  a suspended account would take R2, D1, Queues and Workers with it. deSEC
  holds the DNS instead, and Cloudflare holds no zone at all.
- **There is no R2 custom domain**, now or later. The domain exists solely so
  Resend can verify a sending domain. Images stay on `r2.dev` until a cached
  Worker replaces them — which needs no zone, because Workers Cache is
  zone-independent and caches on `workers.dev`. This is what
  [ADR 0011](docs/adr/0011-r2-custom-domain-requires-a-full-zone.md) assumed
  impossible, and why it is now superseded.

### Deferring the domain

To provision everything that does not need a domain at all:

```sh
./scripts/provision.sh --no-domain
```

The stages that need a domain are skipped and R2 is served from its
auto-generated `pub-<hash>.r2.dev` hostname. **Email is what this costs**:
Resend verification needs DNS records that a hosting free-tier hostname cannot
publish, so Pawster can send only to the operator's own inbox, and because
every actor here is authenticated by control of an inbox
([ADR 0013](docs/adr/0013-shelters-sign-in-with-an-emailed-code.md)) the
operator is the only shelter.

This is an escape hatch, not a plan — `provision-domain.sh` costs nothing and
takes about ten minutes.
