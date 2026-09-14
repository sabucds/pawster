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

### Recorded 2026-09-08, after the photo pipeline (#54)

| Worker | Raw | Gzipped | Of the 3 MB limit |
|---|---|---|---|
| `web` | 886.50 KiB | **228.32 KiB** | 7.4% |
| `digest` | 194.00 KiB | 40.62 KiB | 1.3% |

`web/` grew by **54 KiB gzipped** for three routes, the media library and four new tables'
worth of Drizzle. That is the largest single-ticket jump so far and it is recorded rather
than waved through, because the ceiling is a cliff rather than a slope: a Worker over 3 MB
does not deploy at all. At 7.4% there is still roughly 13× headroom, so this is a data
point and not yet a problem — the number to watch is the *rate*, not the total.

The increase was not decomposed into its parts. Doing so honestly needs a build of the
parent commit to subtract, and the figure above is enough to answer the only question being
asked of it today.


### Recorded 2026-09-08, after the animal page (#57)

| Worker | Raw | Gzipped | Of the 3 MB limit |
|---|---|---|---|
| `web` | 1223.96 KiB | **331.64 KiB** | 10.8% |
| `digest` | 221.79 KiB | 49.29 KiB | 1.6% |

**The parent commit was measured too, so this one is attributed rather than inferred.** At
`ab40fad` — development with #53, #55 and #61 merged and none of them recorded here — `web` was
**318.71 KiB** gzipped. So the animal page, the archive page, the contact hand-off and their five
libraries cost **12.9 KiB**, and the other 90 KiB of the gap to the #54 row above belongs to the
three tickets that landed between them.

That is the decomposition the #54 row said it was not doing, and it is worth the extra build:
without it this row reads as one page costing 103 KiB, which would be the loudest number in the
file and false. The rate to watch is roughly 13 KiB per feature ticket, against 2.7 MB of
headroom.

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

**Superseded by the run below.** The route those figures were taken against rendered four
fields; the page that replaced it is the real one, and it costs about 2.5× as much.


### Recorded 2026-09-08, after the animal page (#57)

The route measured is now `/a/:id/:name` — the real animal page, not the four-field stub the
figures above were taken against. `/animales/:id` no longer exists.

The seed changed with it, and had to: the page 404s unless all four of `isListed()`'s clauses
hold, so the fixture now carries a verification entry and a contact point, and it carries
**three photographs** because a photoless animal is not a page anybody sees. Three is the middle
of `domain/`'s one-to-six range; six is the honest worst case and is worth a hand-run if this
figure ever approaches the ceiling.

Three runs, 500 samples each, local `workerd` on an Apple-silicon laptop, against a local D1
created fresh from `db/migrations` each time.

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Prerendered `/` (control) | 1.100 ms | 1.140 ms | 1.120 ms |
| SSR `/a/:id/:name` | 3.520 ms | 3.540 ms | 3.820 ms |
| **Attributable to the render** | **2.420 ms** | **2.400 ms** | **2.700 ms** |

**24–27% of the 10 ms ceiling**, against 9–12% for the stub. Roughly 2.5× for a page that went
from one join and four fields to six queries, four SHA-256 digests and about 6 KB of markup. The
spread is also much tighter than the earlier record's 40% disagreement, which is what a heavier
route buys: the signal is now well clear of the process-tree noise.

Where the extra milliseconds went, in the order they were spent:

- **Six D1 queries instead of two.** The animal, the shelter's three listing clauses
  (`readShelterFacts()` is itself three), the shelter's public identity, its contact points and
  the session's photographs.
- **Four SHA-256 digests.** A derivative's key is a hash of the source digest plus the spec and
  `db/` deliberately stores none of them, so the page recomputes one per photograph plus the
  social preview. Each hashes a ~70-character string.
- **The page itself.** Gallery, facts, convivencia, the shelter block, the contact hand-off and
  a dozen Open Graph tags.

**The D1 half of that is an artefact of measuring locally, and it inflates the number.** Local
D1 is SQLite inside the same process tree, so its CPU is counted here; on Cloudflare, D1 is a
separate service and the isolate pays wall-clock waiting rather than CPU. The real figure is
therefore *below* this one by whatever the six queries cost, which this method cannot separate
out. Reading 24% as an upper bound is the honest reading, and it is still comfortably inside the
ceiling.

The obvious lever if it ever stops being comfortable: `readShelterFacts()` and
`readShelterPublicIdentity()` read the same row twice, and folding them would cost one query.
Not done, because the first is `domain/`-shaped and hands back the listing clauses and nothing
else, and the second exists precisely so the page never selects the account-email column.

### What this number is not

Local `workerd` on a developer's machine, not an edge isolate. Treat it as an order of
magnitude and a regression detector, not as a compliance figure. The authoritative
measurement needs a deployed Worker, which this repo deliberately cannot do — and the
contrast with [issue #34](https://github.com/sabucds/pawster/issues/34), where the
`env.IMAGES` binding cost 22–56 ms against `cf.image`'s 0–2 ms, is the reminder of what a
real measurement can overturn.

The honest reading: two and a half milliseconds against ten leaves room, the number moved by
2.5× in one ticket, and nothing automated will tell us when it stops leaving room.

## Upright derivatives from a rotated source — unverified offline

Not a measurement yet, and recorded here rather than left implicit because the upload path
**depends** on it and the suite cannot check it. Issue #54 built the pipeline against this
claim:

> Cloudflare's image transformation applies the source's own EXIF/`irot` orientation and
> then discards the metadata — WebP and PNG outputs carry none at all — so a transformed
> image comes back upright without being asked.

Everything downstream is built on that being true. `web/src/lib/photos/dimensions.ts` reads
the orientation tag **only to know what size the result will be**, and deliberately never
asks `cf.image` for a `rotate`: if the pipeline auto-orients and we rotate as well, the
image is turned twice, and the result is the sideways dog ADR 0012 rejected browser-side
resizing to avoid. The two failure modes are symmetrical and both silent, which is why the
claim is written down instead of assumed.

**What the suite does check**, in `web/test/upload.test.ts`: that a rotated HEIC is accepted,
that its stored dimensions are transposed, that every transform names an explicit output
format, and that **no transform ever carries a `rotate`**. That pins our half of the
contract. It cannot pin Cloudflare's, because `cf.image` is the outbound interceptor's third
vendor and no transform runs locally — the same reason
[`testing-seams.md`](testing-seams.md) gives for the CPU ceiling.

**How to settle it**, when there is a deployed Worker to settle it against: upload one
iPhone HEIC with `Orientation=6`, fetch its detail derivative, and check that the returned
WebP is portrait. One photo, one request, and the answer is unambiguous either way. Until
then this is a dependency, not a fact — and its failure mode is a shelter publishing a
sideways animal and never being told.
