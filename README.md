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
database, R2 bucket and Queue over the Cloudflare CLI, writes the captured
values to `.env` and the CI secrets to GitHub, and finishes by writing
`docs/provisioning-record.md`. It is safe to re-run: values already in `.env`
are offered as defaults, and the one secret that must never rotate — the
Do-Not-Contact pepper of [ADR 0010](docs/adr/0010-subscriber-data-retention.md)
— is never regenerated once present.
