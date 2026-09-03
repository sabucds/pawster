# Derivatives are generated once at upload, server-side

[ADR 0006](0006-cloudflare-as-the-single-platform.md) put animal photos in R2, which is storage and
not an image service: it will not resize or convert anything. [ADR 0007](0007-prerender-first-and-filter-in-the-browser.md)
then made the Worker's 10 ms CPU ceiling the governing constraint of the whole platform, which puts
image encoding out of our own isolate entirely. So the derivative set is **fixed, generated exactly
once per photo at upload time by a Cloudflare Images transformation, and the originals are discarded**
after a short recovery window. Nothing is transformed at read time, and nothing is resized on the
shelter's device.

This converts a recurring, traffic-proportional cost into a one-off, catalogue-proportional one, and
it makes page weight deterministic - which matters more here than usual, because on a metered
Venezuelan connection the byte count of a listing page is a product decision rather than an
implementation detail.

## The derivative set

Four derivatives, because four consumers have genuinely different budgets. `N` is the photo count,
1-6 with the first primary, enforced as a creation-time invariant by the domain model.

| Derivative | Consumer | Dimensions | Format | Applies to |
|---|---|---|---|---|
| Digest thumbnail | the digest email | 144x144 crop | **JPEG** | primary only |
| Card thumbnail | listing card, filter index, gallery strip | 400px long edge | WebP | every photo |
| Detail image | animal detail page | 1280px long edge | WebP | every photo |
| Social preview | `og:image`, WhatsApp unfurl | 1200x630 crop | JPEG | primary only |

- **The digest thumbnail is JPEG, and this is not a detail.** Outlook's Word rendering engine does
  not render WebP at all, and every Gmail surface is only *partially* supported - caniemail records
  it as "converts file to jpg", meaning the WebP bytes we send are not the bytes Gmail displays. A
  transcode we neither control nor measure is worse than shipping the format the client wants.
- **The card thumbnail is generated for every photo, not just the primary.** Otherwise a six-photo
  gallery has nothing small to show and must pull 6 x 140 KB of detail images on a metered
  connection. The strip is the reason; the card is the bonus.
- **1280px is a mobile-first number**, not a desktop compromise: a 390px viewport at DPR 3 is
  1170px.
- Social previews matter more than they look. WhatsApp is how listings actually spread in Venezuela,
  and every share triggers an unfurl fetch.

Worst case is roughly **1.05 MB per animal** at six photos, so R2's 10 GB Free allowance is
**~9,500 animals** - not the ~12,500 quoted in the original storage research, which assumed four
photos and predated the domain model.

## Considered options

**Resize in the browser before upload.** This was the leading candidate: it costs no Cloudflare
feature and keeps the CPU ceiling out of the question entirely. **Rejected on four independent
counts**, and the shape of the rejection is what matters - every failure mode is silent, on exactly
the devices the option was meant to protect.

1. **iOS Safari cannot canvas-encode WebP at any version.** MDN's compat data records `false`, not a
   version, for `toBlob`/`convertToBlob`/`toDataURL` with `image/webp`. WebKit's `toEncodingMimeType`
   substitutes `image/png` for any unsupported type, as the HTML Standard requires - so asking an
   iPhone for WebP returns a **PNG**, which for a photograph is very likely *larger* than the JPEG it
   started from. There is not even a reliable feature test: whether `Blob.type` reflects the
   substitution is undocumented.
2. **It cannot decode what an iPhone actually uploads.** iPhones shoot HEIC by default. Chrome cannot
   decode HEIC in a canvas; Cloudflare Images accepts HEIC input on the Free plan.
3. **It has no path for primary-photo promotion.** Once the original is purged the shelter's device
   no longer holds the file, so promoting another photo to primary must read from R2 - server-side by
   construction. A server-side path therefore has to exist regardless, which reduces browser-side
   resize from an alternative to a *second* code path needing its own justification.
4. **EXIF orientation is undocumented on old devices.** `createImageBitmap` defaults to
   `imageOrientation: "from-image"` and there is no implemented way to opt out, but acceptance of
   that value dates only to Chrome Android 112 / iOS Safari 16, and no primary source states the
   prior default. The `drawImage` fallback is explicitly unreliable - MDN: "will ignore all EXIF
   metadata... especially troublesome on iOS devices." The old Android phone this decision worried
   about is precisely the device where the behaviour is unspecified.

A shelter would see none of these as an error. It would see its animal published with a sideways,
oversized, wrongly-encoded photo.

**Transform on the fly at read time.** Rejected before this ADR by the storage research, and the
numbers still hold: Cloudflare Images bills a *unique transformation* per (image x parameter set)
per calendar month regardless of cache status, which caps a read-time design at roughly 1,000
actively-viewed animals per month, forever. Pre-generating moves the binding constraint back to
storage, where it is a lifetime total rather than a recurring rate.

**Storing the originals permanently.** Rejected on arithmetic: at ~12 MB per animal the platform caps
out near 830 animals.

## Consequences

- **The 1280px detail image is our master, and its dimensions are a one-way door.** The storage
  research promised that a new breakpoint "means a backfill over the whole catalogue... minutes of
  compute" while also discarding the originals; those two claims are incompatible, and this ADR
  keeps the second. Every future derivative must be derivable from 1280px. A larger one cannot be
  backfilled at all.
- **Originals live 7 days in a separate bucket under an R2 lifecycle rule, then expire.** At ~100
  animals/month that is ~0.3 GB standing, about 3% of the allowance, and it converts an
  irreversible pipeline bug - a bad crop, a broken encoder - into a recoverable one. The rule also
  collects abandoned upload sessions, so neither needs code. Expiry is "typically within 24 hours"
  of the mark, so 7 days is a floor rather than a guarantee. A separate bucket buys no quota
  isolation (the 10 GB is per account) and lifecycle rules can be prefix-scoped, so this is a
  preference for clean metrics, not a requirement.
- **That bucket must never be public.** Transformations default to `metadata=copyright`, which
  strips GPS, and any WebP/PNG/AVIF output discards all metadata unconditionally - so derivatives
  are clean by default. The retained originals are not: a volunteer photographing a foster animal
  indoors embeds that home's coordinates.
- **A new monthly rate limit joins ADR 0006's table: 5,000 image transformations per calendar
  month.** The Images binding is metered against the same counter as the URL form - Cloudflare:
  "This metric is used when using the Images binding or optimizing images that are stored outside of
  Images." The set above costs **2N + 2** transformations per animal (4 at one photo, 14 at six), so
  the ceiling is **~350-500 new animals per month**, recurring. Exhaustion returns error 9422, is
  explicitly *not* billed, and the `onerror` fallback does not apply to the binding. Since it fails
  closed mid-upload, the remaining budget is checked **before any bytes are accepted** and an upload
  that will not fit is refused with a message. Note the two ceilings are roughly matched: at ~400
  animals/month, ~9,500 animals is about two years away.
- **Transformations use the `cf.image` fetch form, and the `env.IMAGES` binding is ruled out.**
  This clause used to defer the choice to measurement, in the spirit of ADR 0007's two unverifiable
  numbers, because whether the binding's encode CPU counted against our 10 ms was undocumented -
  zero occurrences of "CPU" across Cloudflare's entire Images documentation. The measurement was
  taken on 2026-09-03 against a real Free-plan account
  ([#34](https://github.com/sabucds/pawster/issues/34)), and it is not close. **The binding's encode
  runs in our isolate and costs 22-56 ms of CPU at the median, with single invocations observed to
  78 ms - three to eight times the 10 ms ceiling. `cf.image` costs 0-2 ms, every sample, including
  the 1280px WebP.** The distributions do not overlap at any sample. Two controls make the
  attribution airtight: fetching the 3 MB source and discarding it unread costs **0 ms**, so none of
  the binding's cost is the source read; and the binding's CPU **rises with the weight of the
  output** (a 144x144 JPEG is cheaper than a 1280px WebP from the same input) while `cf.image` stays
  flat, which is only possible if the encode is running in our isolate. The Free plan's 10 ms is
  soft in practice - every over-budget invocation returned `outcome: ok` and no 1102 was ever seen -
  but Cloudflare's own wording is that a Worker "hitting the limit consistently" is terminated, and
  a steady upload path is precisely the consistent case, so this is not a licence to spend 50 ms.
- **The original is made fetchable to the image pipeline by a token-gated Worker route, not a public
  bucket.** `cf.image` needs its source reachable by URL, which the "never public" rule above
  appears to forbid. It does not: a Worker route that checks a capability token and only then serves
  the bytes is fetchable by Cloudflare's image pipeline and by nobody else. Measured both ways - the
  transform through the gated route succeeds at **1 ms** of CPU and returns a real JPEG, and the
  same route with a bad token is refused **403**, surfacing to the caller as `cf-resized: err=9408`.
  This is the same capability-not-a-session shape as [ADR 0008](0008-confirmation-is-a-capability-not-a-session.md).
- **A Worker cannot reach its own Static Assets, or any same-host URL, with a plain `fetch()`.** It
  loops back into the Worker and never reaches the asset router: the identical URL that serves
  3,190,813 bytes from outside returns **404** from inside. The `ASSETS` binding is the way in.
  `cf.image` is exempt, because the image pipeline resolves the URL outside the isolate - which is
  also why the gated-route arrangement above works at all.
- **Photos upload one per request, browser to Worker to R2, streamed.** The Free request-body limit
  is 100 MB (an account-plan limit, not a Workers one), HTTP duration is documented as unlimited,
  and streaming to `R2.put()` is I/O rather than CPU - so presigned S3 URLs, their CORS policy and
  their credentials in the Worker are all unnecessary complexity here. One photo per request also
  keeps the subrequest count near 5 of the Free plan's 50; doing a six-photo animal in one
  invocation would spend 34-40. **An Images call spends exactly one subrequest**, measured on
  2026-09-03 ([#34](https://github.com/sabucds/pawster/issues/34)) by standing at the edge of the
  limit and taking one more step: with 50 subrequests already spent the transform raises "Too many
  subrequests", with 49 spent it proceeds. Images is absent from Cloudflare's documented subrequest
  list, so this had to be measured rather than read; the count above is unaffected, since it already
  assumed one.
- **Derivative keys are immutable and content-addressed**, hashed over the source bytes plus the
  derivative spec, served `Cache-Control: immutable`. This is what makes ADR 0007's
  regenerate-the-index-on-publish safe rather than racy: an adopter reading mid-write gets a
  coherent *old* index, never a new index pointing at an object that does not exist yet. It also
  means **no cache purge exists anywhere in the publish path** - a purge would be Worker work and an
  API dependency, against ADR 0007's rule that the Worker runs as rarely as possible. The cost is
  opaque keys and an orphan sweep. Immutability is what makes the custom domain of
  [ADR 0011](0011-r2-custom-domain-requires-a-full-zone.md) pay off, since a derivative can be
  cached at the edge forever and never re-read from the bucket.
- **Nothing partial ever becomes an animal.** Photos are staged under an upload session and the
  animal row is created last, referencing derivative keys that already exist - which is what lets
  the domain model keep 1-6-photos-first-primary as a creation-time invariant with no `Draft` state.
  It also settles the filter-index ordering worry for free: the animal enters the index at creation,
  by which time the thumbnail provably exists. Sessions are resumable for 24 hours, because losing
  five successful uploads to one dropped connection is the failure this platform can least afford.
- **Photo mutation is server-side and synchronous, and an animal never has an incomplete derivative
  set.** Promoting a photo to primary needs only its digest thumbnail and social preview (its card
  thumbnail already exists), and any change to the primary rewrites the filter index. Deleting is
  refused at one photo remaining; deleting the primary promotes the next. A reorder is a
  Confirmation under the existing definition, so it refreshes `lastConfirmedAt`. The alternative -
  async regeneration - opens a window in which the digest reads the index and finds an animal whose
  thumbnail does not exist.
- **The caps are ours, because R2 bills instead of failing.** Three, in the order they bite: reject
  any input over 12 MB or beyond a maximum dimension *before storing anything* (R2 will happily
  accept a 5 TiB object; the binding's own input ceiling is 20 MB); alarm the admin's inbox at 6 GB;
  and at 8 GB **degrade to one photo per animal rather than refusing uploads** - a primary-only
  animal costs ~0.24 MB instead of ~1.05 MB, roughly quadrupling the remaining headroom, and a
  one-photo listing still finds a home where a rejected upload loses a shelter permanently. Outright
  refusal waits until ~9.5 GB. The animal count is the cap's proxy for stored bytes, because the
  derivative set is fixed by us and so bytes-per-animal is bounded by construction; a byte ledger in
  D1 could drift, a count we already hold cannot.
- **Crops use saliency-aware `gravity=auto`, which is available on the Free plan and on both
  forms.** Measured on 2026-09-03 ([#34](https://github.com/sabucds/pawster/issues/34)): `auto`
  succeeds through `cf.image` *and* through the binding's `.transform()`, and it is not silently
  ignored - the same source at 144x144 yields different bytes under `auto` than under centre-crop.
  It is also not undocumented, only under-documented: the published
  `@cloudflare/workers-types` declares `ImageTransform.gravity` with `"auto"` among its values, so
  this ADR's earlier claim that `cf.image` is "the only form for which `gravity` is documented at
  all" was true of the prose docs and false of the types. Retained for the record, since it was one
  of the two arguments that pointed at `cf.image`: the argument was wrong, and the conclusion
  survives anyway on CPU alone. The original wording follows.
- **~~Crops are centre-cropped in v1~~**, ~~upgrading to saliency-aware `gravity=auto` if it proves
  available on the Images Free plan~~ - Cloudflare documents it for exactly this case ("useful when
  you don't know the contents of the image ahead of time, such as with user-generated content") but
  attaches no plan badge either way, and does not show it for the binding's `.transform()` at all.
  Since the transform runs once at upload, a better gravity costs nothing at read time. A crop UI is
  out of scope: a shelter with a headless thumbnail already has a remedy in reordering or replacing
  the photo.
