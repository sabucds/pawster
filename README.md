# pawster

A mobile-first web app where Venezuelan animal shelters publish animals for
adoption, adopters browse and filter them, and adopters subscribe to periodical
email digests of animals matching their criteria.

Design decisions live in [`docs/adr/`](docs/adr/); the glossary is in
[`CONTEXT.md`](CONTEXT.md). Planning is charted on
[issue #1](https://github.com/sabucds/pawster/issues/1).

## Provisioning

The third-party accounts, the domain and its Cloudflare zone are provisioned by
an interactive wizard:

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
  lifecycle rule (ADR 0012, still on the unmerged
  [`worktree-photo-derivatives`](../blob/worktree-photo-derivatives/docs/adr/0012-derivatives-are-generated-once-at-upload.md)).
  The derivatives bucket is served over a custom domain; this one must not be,
  because a retained original still carries the EXIF the derivatives strip.
- **A dead-letter queue** beside the digest queue
  ([ADR 0009](docs/adr/0009-digest-delivery-and-retry.md)): its consumer is what
  pings the Healthchecks `/fail` endpoint, so it has to exist as a real queue
  before the digest Worker can name it.
