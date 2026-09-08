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

## Filter index size

```sh
npm run check:filter-index
```

Serializes a synthetic catalogue through `domain/src/filter-index.ts`'s **own** `serializeIndex`
— the function the regenerator calls — and gzips the result. It exits non-zero if the index
stops fitting [ADR 0007](adr/0007-prerender-first-and-filter-in-the-browser.md)'s ~150 KB
metered-connection budget at 2,500 listed animals, which is
[ADR 0018](adr/0018-the-filter-index-is-rewritten-whole-and-found-through-a-pointer.md)'s own
working figure for the platform's scale.

### Recorded 2026-09-08, with the listing (#56)

| Listed animals | Raw | Gzipped | Per animal, gzipped |
|---|---|---|---|
| 2,500 | 674.1 KB | **51.0 KB** | 20.4 B |
| 9,500 | 2,561.4 KB | 187.4 KB | 19.7 B |

**ADR 0018's 33.4 KB does not describe the shipped index, and the difference is identifiers.**
That figure comes from the issue #17 prototype, which synthesised 4-character animal ids,
3-character shelter ids and a thumbnail key of `id + "-1"`. The rows the platform actually
writes carry two `crypto.randomUUID()`s at 36 characters each and a content-addressed
derivative key of `d/` plus a 64-character hex digest plus an extension
([ADR 0012](adr/0012-derivatives-are-generated-once-at-upload.md)) — about **105 characters an
animal the prototype never counted**, and high-entropy ones that gzip cannot fold away.

So the measured index is **20.4 B/animal gzipped against the ADR's 13.4**, and one conclusion
in ADR 0018 does not survive it. That ADR says the index's read budget and R2's storage cap
"expire at almost the same moment", with a ~9,500-animal endgame at ~127 KB inside the budget.
Measured, 9,500 animals is **187.4 KB**, and the budget is crossed at about **7,578**. The
index expires *first*.

Three things keep that from being urgent, and they are worth stating so the next reader does
not reopen a decision on a number that does not bind yet:

- **At the scale that binds today it is a third of the budget.** 51.0 KB at 2,500 animals,
  which is the figure ADR 0018 spends all of its own arithmetic on.
- **The 9,500 figure was already called optimistic.** ADR 0012 derived it, and ADR 0016 says it
  is generous "by about a gigabyte's worth" — so R2's 10 GB is reached at fewer animals than
  that, and a lower real ceiling is a smaller index.
- **ADR 0007's trigger is unchanged, only earlier.** Its stated answer — "when the index stops
  being cheap to download on a metered connection, filtering has to move server-side" — is
  still the answer. What has moved is when: around 7,600 listed animals rather than never.

The cheapest lever, if it ever does bind, is the animal id. It is 36 of those characters, and
the issue #17 prototype's own contact CTA writes a short one — `pawster.org/a/m6p2` — so a
shorter public address was the intended shape before #55 chose UUIDs. Changing it changes every
animal's public URL, which is why it is named here rather than done.

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
