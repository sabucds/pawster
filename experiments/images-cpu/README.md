# Does an Images transformation cost us Worker CPU?

A throwaway probe for [issue #34](https://github.com/sabucds/pawster/issues/34).
Deploy it, read the numbers, delete it. Nothing here ships.

ADR 0012 fixed four derivatives generated server-side once at upload, and then
deliberately left one thing open: whether to invoke the transform through
`env.IMAGES` or through `fetch(url, { cf: { image } })`. The binding is simpler
and needs nothing reachable by URL, but **whether its encode CPU lands in our
isolate is undocumented** — there are no occurrences of "CPU" anywhere in
Cloudflare's Images documentation, and the Workers limits page excludes
`fetch()`, KV and database waits without saying anything about bindings. Against
a 10 ms Free-plan ceiling that is not a detail. `cf.image` avoids the question
rather than answering it, which is why the recorded default when the measurement
is inconclusive is `cf.image`.

Documentation was re-checked on 2026-09-03 and still does not answer it. So:
measure.

## Result (2026-09-03) — the binding is out

Measured on a real Free-plan account, 9 warm samples per scenario, 12.2 MP / 3.19 MB JPEG source.
Every sample, no overlap between the two families:

| | CPU p50 | observed range | vs the 10 ms ceiling |
| --- | --- | --- | --- |
| `env.IMAGES` 144×144 JPEG | 22–44 ms | 31–57 ms | **3–5× over** |
| `env.IMAGES` 1280px WebP | 27–56 ms | 47–78 ms | **5–8× over** |
| `cf.image`, any of the above | **0–1 ms** | 0–2 ms | 0.1× |
| source fetched and discarded unread | 0 ms | 0 ms | — |

Two controls make it airtight. Fetching the 3 MB source and discarding it unread costs **0 ms**, so
none of the binding's cost is the source read. And the binding's CPU **rises with the weight of the
output** while `cf.image` stays flat — only possible if the encode runs in our isolate.

Also settled:

- **`gravity: "auto"` works on the Free plan through both forms**, binding included, and is not
  silently ignored (different bytes from centre-crop). The types declare it; only the prose docs omit it.
- **An Images call spends exactly one subrequest** — at 50 already spent it raises "Too many
  subrequests", at 49 it proceeds.
- **HEIC is accepted by both forms**; `.info()` reports `image/heic`, 4032×3024.
- **`cf.image` can source from a token-gated Worker route** — 200 and a real JPEG at 1 ms, while a
  bad token is refused 403 (`cf-resized: err=9408`). So no public bucket is needed.
- **A Worker cannot reach its own Static Assets by `fetch()`** — same-host URLs loop back and 404.
  Use the `ASSETS` binding. `cf.image` is exempt.
- **R2 analytics are readable on Free**, both `r2StorageAdaptiveGroups` and `GET .../r2/metrics`.
- The 10 ms limit is **soft**: every over-budget invocation returned `outcome: ok` and no 1102 was
  seen. Cloudflare terminates a Worker "hitting the limit consistently", which a steady upload path
  would be.

Raw numbers: `results/2026-09-03-images-cpu.json`.

## What it measures, and why by subtraction

An invocation's CPU includes the isolate's own startup and the cost of pulling a
body through, so an absolute reading for the binding means nothing on its own.
Every transform has a control that performs the identical I/O and no transform:

```
binding encode CPU   =  CPU(/binding)  - CPU(/control/fetch?mode=cancel)
cf.image encode CPU  =  CPU(/cfimage)  - CPU(/noop)
```

The controls are not interchangeable, and choosing the wrong one flatters the
binding. `mode=cancel` gets the source and discards it **unread**, which is what
the binding does — it is handed a stream and never reads the bytes in JS. The
plain drain control reads all 3 MB through JS, which costs ~20-30 ms of our own
CPU and has nothing to do with Images. `cf.image` never sees the source in the
isolate at all, so its control is the empty invocation.

`cf.image` is documented-safe for CPU, so **its difference is the measurement's
own noise floor**. If the binding's difference sits on that floor, the binding is
free of our budget; if it sits milliseconds above it, the binding spends it. That
comparison is the finding — not either raw number.

Fixtures are served by the probe's own Static Assets, so the experiment is one
`workers.dev` hostname with no bucket and no public origin. That is deliberate:
it also tests #19's unverified claim that the `cf.image` form works on any zone
hosting a Worker, `workers.dev` included.

## Run it

```sh
npm install
npm run fixtures          # or: node scripts/make-fixtures.mjs ~/Pictures/IMG_1234.HEIC
npx wrangler login        # a real Free-plan account; do not upgrade it
npm run measure
```

`measure` deploys the probe, opens a `wrangler tail` session, drives every
scenario, joins each response to its own trace event by a unique cache-busting
token, and prints a table. Full detail lands in `results.json`.

Then, and this matters, tear it down:

```sh
npm run teardown
```

### Use a real phone photo if you can

`npm run fixtures` synthesises a 4032×3024 (12.2 MP), ~3.2 MB JPEG and converts
it to HEIC. Encode cost tracks pixel count, so that is a fair proxy for the CPU
question. It is *not* a fair proxy for whether the pipeline copes with what an
iPhone actually writes — its EXIF, its colour profile, its subsampling. Pass a
real photo as an argument if one is to hand; the manifest records which was used
so the resolution can say so honestly.

## What comes back

| scenario | question it answers |
| --- | --- |
| `noop` | what an invocation costs before doing anything |
| `binding:*` vs `cfimage:*` | **the ticket** — does the binding's encode land in our 10 ms? |
| `*:heic:*` | does either form accept the HEIC an iPhone uploads? |
| `*:gravity-auto` | is `gravity=auto` available on Free, and reachable through `.transform()`? |
| `subreq:49+binding` | does a binding call consume one of the Free plan's 50 subrequests? |
| `info:heic` | does the binding admit HEIC at all (`.info()` is free to call) |

Watch for `1102` / `exceededCpu` (over the ceiling) and `9422` (out of
transformations) in the outcomes column — both are results, not run failures.

### Cost

Each measured transform sample is a distinct transformation, because an identical
repeat would be served from cache and read as free. A default run spends roughly
**60 of the 5,000 monthly transformations**, and no R2 storage at all.

## The third question

Whether R2's analytics are readable at $0 is separate, needs an API token rather
than an OAuth login, and is only a periodic reality check against #36's measured
byte total — not load-bearing:

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/probe-r2-analytics.mjs
```
