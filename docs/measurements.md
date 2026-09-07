# Measurements

[ADR 0007](adr/0007-prerender-first-and-filter-in-the-browser.md) closes on two numbers
that "are unverifiable from documentation and must be measured rather than assumed": the
actual gzipped Worker size, and actual per-request CPU on the SSR routes. Each has one
command. Neither needs a Cloudflare account or any credentials.

These are **checks, not tests**. Nothing here fails `npm test`, and nothing here enforces
the 10 ms CPU ceiling — see [`testing-seams.md`](testing-seams.md#what-no-test-here-can-catch).

## Worker bundle size

```sh
npm run check:bundle-size
```

Runs `wrangler deploy --outdir bundled/ --dry-run` for both Workers — the command ADR 0007
names — and reads the size out of Wrangler's own report rather than measuring the output
directory, because what counts against the limit is what Wrangler would upload and only
Wrangler knows exactly what that is. It exits non-zero if either Worker is over.

### Recorded 2026-09-07

| Worker | Raw | Gzipped | Of the 3 MB limit |
|---|---|---|---|
| `web` | 715.84 KiB | **173.89 KiB** | 5.7% |
| `digest` | 181.40 KiB | **36.44 KiB** | 1.2% |

Two Workers, so two separate 3 MB budgets — which is one of the reasons ADR 0007 splits
them. For scale, the OpenNext/Next.js bundle that ruled Next out of the running was
2,295.89 KiB gzipped against the same 3 MB: `web/` at 173 KiB has roughly **17×** the
headroom that option would have had on its first day.

## Per-request SSR CPU

```sh
npm run check:ssr-cpu
```

`workerd` reports per-request CPU to nobody — not to the Worker, not to a local log — so
this measures the CPU of the whole `wrangler dev` process tree across 500 requests and
divides. That raw figure includes HTTP parsing, the local proxy and the asset router, so
it is an upper bound rather than an answer.

**The prerendered page is the control that turns it into an answer.** `/` is served by the
asset router without invoking Worker code, so it pays every cost the SSR request pays
except the render. The difference is the Worker's own CPU, reached by subtraction rather
than by trusting an absolute number from a machine that is not Cloudflare's.

### Recorded 2026-09-07

Three runs, 500 samples each, local `workerd` on an Apple-silicon laptop, against a local
D1 created fresh from `db/migrations` each time.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Prerendered `/` (control) | 1.080 ms | 1.320 ms | 1.220 ms |
| SSR `/animales/:id` | 1.940 ms | 2.540 ms | 2.100 ms |
| **Attributable to the render** | **0.860 ms** | **1.220 ms** | **0.880 ms** |

Roughly **9% of the 10 ms ceiling**, with one run at 12%, for a route that does one indexed
D1 join and renders a page — the shape ADR 0007 predicted when it called the detail page
"one row from D1, comfortably inside 10 ms".

Three runs rather than two because two disagreed by 40%. The spread is the point: a
subtraction of two noisy process-tree totals is not a precise instrument, and reading any
single run as *the* figure would be over-reading it. Treat the ceiling as ~10× away, not
as a number known to two decimal places.

### What this number is not

Local `workerd` on a developer's machine, not an edge isolate. Treat it as an order of
magnitude and a regression detector, not as a compliance figure. The authoritative
measurement needs a deployed Worker, which this repo deliberately cannot do — and the
contrast with [issue #34](https://github.com/sabucds/pawster/issues/34), where the
`env.IMAGES` binding cost 22–56 ms against `cf.image`'s 0–2 ms, is the reminder of what a
real measurement can overturn.

The honest reading: about a millisecond leaves room, and nothing automated will tell us
when it stops doing so.
