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
- **Whether to use the `env.IMAGES` binding or the `cf.image` fetch form is deliberately left to
  measurement**, in the spirit of ADR 0007's two unverifiable numbers. The binding is simpler -
  bytes stream from the request through the transform into R2 with nothing publicly fetchable - but
  whether its encode CPU counts against our 10 ms is **undocumented**: there are zero occurrences of
  "CPU" across Cloudflare's entire Images documentation, and the Workers limits page excludes
  `fetch()`, KV and database waits without naming bindings generically. The `cf.image` fetch form
  avoids the question rather than betting on it, because the exclusion is documented for `fetch()`
  verbatim, and it is the only form for which `gravity` is documented at all. **If the measurement
  is inconclusive, use `cf.image`.** The zone requirement is already met either way:
  [ADR 0011](0011-r2-custom-domain-requires-a-full-zone.md) put Pawster on a full Cloudflare zone,
  and the `cf.image` form works on any zone hosting a Worker regardless.
- **Photos upload one per request, browser to Worker to R2, streamed.** The Free request-body limit
  is 100 MB (an account-plan limit, not a Workers one), HTTP duration is documented as unlimited,
  and streaming to `R2.put()` is I/O rather than CPU - so presigned S3 URLs, their CORS policy and
  their credentials in the Worker are all unnecessary complexity here. One photo per request also
  keeps the subrequest count near 5 of the Free plan's 50; doing a six-photo animal in one
  invocation would spend 34-40.
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
- **Crops are centre-cropped in v1**, upgrading to saliency-aware `gravity=auto` if it proves
  available on the Images Free plan - Cloudflare documents it for exactly this case ("useful when
  you don't know the contents of the image ahead of time, such as with user-generated content") but
  attaches no plan badge either way, and does not show it for the binding's `.transform()` at all.
  Since the transform runs once at upload, a better gravity costs nothing at read time. A crop UI is
  out of scope: a shelter with a headless thumbnail already has a remedy in reordering or replacing
  the photo.
