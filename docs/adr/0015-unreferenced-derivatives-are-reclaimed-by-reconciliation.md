# Unreferenced derivatives are reclaimed by nightly reconciliation

[ADR 0012](0012-derivatives-are-generated-once-at-upload.md) keeps originals for 7 days under an R2
lifecycle rule and adds that "the rule also collects abandoned upload sessions, so neither needs
code". That sentence is true of an abandoned session's **originals**, which sit in the bucket the
rule governs, and false of its **derivatives**, which are written to `pawster-media` - a bucket with
no lifecycle rule at all. ADR 0012 had already named the price of its own content-addressed keys as
"opaque keys and an orphan sweep", and then never specified the sweep. This ADR specifies it:
**every derivative object that no animal and no live upload session references is deleted by a
nightly reconciliation pass, and the same pass measures actual stored bytes, replacing the
animal-count proxy that could not see those objects by construction.**

## The hole is wider than an abandoned session

Chasing the abandoned-session case turns up three more sources of the same object, all of them on
animals that exist, and none covered by any rule today:

- **An abandoned upload session.** Four staged photos are ten derivative objects, roughly 0.73 MB,
  stranded permanently.
- **A deleted photo.** ADR 0012 refuses deletion at one photo remaining, but every deletion above
  that strands a card thumbnail and a detail image.
- **A promoted primary.** Promotion mints a digest thumbnail and a social preview for the new
  primary and strands the old primary's pair.
- **The 12-month photo drop.** An adopted animal keeps a `noindex` archive page and loses its photos
  twelve months after it unlists. Note this was settled while deciding how an animal stops being
  listed and is **recorded nowhere in `docs/adr/`** - [ADR 0001](0001-no-automatic-unlisting.md)
  covers unlisting but is silent on archiving and on photos. It has never had a mechanism behind it
  because it has never had a record behind it either.

The arithmetic on any one of these is small - on the order of 0.35 GB a year against a 10 GB
allowance. What makes them worth code is not the volume but that R2 is the one component
[ADR 0006](0006-cloudflare-as-the-single-platform.md) says **bills instead of failing**, and that
ADR 0012's storage cap uses the animal count as its proxy for stored bytes. That proxy is sound only
if every stored byte belongs to an animal that exists. These bytes do not, so they are invisible to
the exact control meant to catch them, and they accumulate monotonically and silently.

## Reclaim by reference, never by ownership

Derivative keys are hashed over the source bytes plus the derivative spec, so **identical input
bytes produce an identical key**. Two animals in a bonded group photographed in one shot share one
object. So does an abandoned session and the retry that follows it - which is the single most likely
sequel to abandonment, a shelter closing the tab and starting over with the same four photos.

This makes the intuitive fix actively dangerous. Deleting "the objects this abandoned session wrote"
would delete the live animal's derivatives, and because derivatives are served
`Cache-Control: immutable`, the damage would surface slowly as edge caches expire rather than at the
moment of the mistake. **"This key is dead" is never a fact about a key.** Only "no animal
references this key" is, and it can only be established by looking at every reference.

## Reconciliation, not a to-delete list

The alternative was a `pending_deletion` table written by each path that unreferences a derivative,
drained nightly - cost proportional to churn rather than to catalogue size. It loses on three
counts:

- **The largest class has no writer.** Abandonment is derived, not stored (below), so no code is
  running at the moment a session dies. The job would have to derive that set by query regardless,
  so a to-delete list could never be the whole answer.
- **A missed path leaks silently and permanently** - which is the precise failure being fixed here,
  in the direction nothing can see.
- **A tombstone is wrong about shared keys.** It asserts a key is dead when another animal may still
  hold it, so it would have to be reference-checked when drained, at which point it is reconciliation
  carrying extra bookkeeping.

This is the argument the platform has already made twice. [ADR 0009](0009-digest-delivery-and-retry.md)'s
sent-set beat a watermark because reconciliation catches a corrected animal that a watermark
silently drops, and [ADR 0010](0010-subscriber-data-retention.md)'s purges are reconciliation-based
for the same reason. A to-delete list is a watermark.

Reconciliation is also affordable, and not for the reason first assumed. Cloudflare excludes I/O
waits from CPU time - the Queues limits page says so verbatim for storage calls - so the 10 ms
ceiling is not the constraint. The real ones are 1,000 internal subrequests per invocation and 15
minutes of cron wall time. At the ~9,500-animal endgame a full pass is ~133 `list` calls plus
batched deletes of up to 1,000 keys each, and `list` is Class A against 1M free per month while
**`DeleteObject` is a free operation, neither Class A nor B**. The sweep costs essentially nothing
however often it runs.

## The decision

- **Abandonment is derived, never stored.** An upload session gains no `Abandoned` state and no
  writer to set one; it is abandoned iff it is older than 24 hours with no committed animal, which
  is also exactly the query the sweep runs. Storing the state would need a writer, and the only
  writer available is the job already doing the deleting. This follows ADR 0001's derived staleness
  and [ADR 0004](0004-age-bands-are-derived.md)'s derived age bands, and it keeps ADR 0012's refusal
  of a `Draft` state intact.
- **A key is deleted only when all three conditions hold**: no animal references it, no upload
  session younger than 24 hours holds it, and the object itself is older than 24 hours. R2 returns
  `uploaded` on every listed object, so the third needs no join, and it closes the race in which an
  animal is committed between the reference read and the delete.
- **The 12-month photo drop becomes an unreference, not a deletion.** The drop writes to D1
  and touches R2 not at all; the sweep collects what is now unreferenced. This gets the shared-key
  case right for free, where a dedicated deletion path would have to remember to check and would
  eventually forget.
- **`pawster-media` gains a prefix convention, and reclamation's scope is an allowlist.** Derivatives
  move under `d/`, the compact JSON filter index under `i/`, and the sweep lists **`d/` only, never
  the bucket root**. The index is referenced by no animal, so a root-scoped sweep would delete it and
  [ADR 0007](0007-prerender-first-and-filter-in-the-browser.md) only regenerates it on publish - the
  listing would stay empty until the next animal was published. The direction is the decision: a
  denylist would delete every object type added later by default, an allowlist makes anything new
  invisible to reclamation until it is deliberately opted in. Content-addressed keys are indifferent
  to a prefix, so immutability, edge caching and [ADR 0011](0011-r2-custom-domain-requires-a-full-zone.md)'s
  custom domain are untouched.
- **The run refuses rather than deletes when anything looks wrong.** This is the only operation in
  the platform that destroys data with no recovery path: originals are gone after 7 days, and
  `immutable` caching means a wrong delete surfaces slowly instead of immediately. So the run aborts
  entirely if the reference query fails or returns partially - **never delete on an incomplete
  read** - and if the computed delete set exceeds `max(200 objects, 10% of listed objects)` it
  deletes nothing and mails the admin inbox with the counts. The floor keeps an early, tiny
  catalogue from tripping on ordinary churn; the percentage catches the systemic failure. The
  asymmetry is the whole argument: **a skipped sweep costs about a megabyte and self-heals
  tomorrow, a wrong sweep is permanent.**
- **The measured byte total replaces ADR 0012's animal-count proxy.** `list` returns each object's
  size, so the true total falls out of a pass that is already happening. ADR 0012 rejected a D1 byte
  ledger because it could drift; a total recomputed from the buckets each night cannot, on the same
  reasoning that derives age bands rather than storing them. The sweep writes one row - measured
  bytes, timestamp, resulting mode - and the upload path reads that row instead of counting animals,
  because it cannot afford to list a bucket per upload. The row is up to 24 hours stale against
  thresholds 2 GB apart, while a day's growth is roughly 14 MB.
- **The measurement sums both buckets.** R2's 10 GB is per account, as ADR 0012 says itself, so
  `pawster-originals` counts. Its "~0.3 GB standing" assumed ~100 animals a month; at the ~350-500 a
  month its own transformation ceiling permits, seven days of retained originals is nearer **1 GB**,
  and ADR 0012's ~9,500-animal figure is optimistic by about that much. Measuring both makes the
  estimate moot rather than needing a better one.
- **Reclamation runs as another preamble step on the daily digest run**, not on a schedule of its
  own. ADR 0010 settled this: "a second schedule would be a second thing that can die silently." It
  inherits the Healthchecks.io watchdog and writes its reclaimed counts and bytes into the
  `Digest Run` summary, which is what makes the refuse-and-alarm rail visible. The Free plan's cap
  of 5 Cron Triggers per account is a further reason, but not the reason.

## Consequences

- **The hole this ADR closes is closed at the root, not patched.** Orphaned bytes stop being
  invisible-by-construction because they are counted rather than inferred away. Any future orphan
  class - including one from a bug nobody has thought of - is collected by the same pass without
  new code, because reconciliation needs no path to remember anything.
- **Reclamation lags by up to a day, and that is the design.** An orphan lives at most one run,
  roughly a megabyte's worth. The alternative - deleting in the request path - would put the
  platform's only irreversible operation on the hot path.
- **A stale measurement fails toward caution.** If the sweep stops running the row stops moving, so
  the upload path treats a measurement older than 3 days as a reason to degrade to one photo per
  animal rather than as licence to keep trusting the last value. ADR 0010's watchdog is what makes
  this a bounded window rather than an open one.
- **ADR 0012's cap ladder keeps its thresholds and changes its input.** Alarm at 6 GB, degrade to one
  photo per animal at 8 GB, refuse at ~9.5 GB - all now driven by measured bytes across both buckets
  rather than by animal count.
- **The prefix convention is cheap now and expensive later, which is why it is here.** Nothing is
  stored yet, so `d/` and `i/` cost nothing today; adopting them once objects exist would need a
  migration, and R2's Workers binding has no copy or move - its surface is exactly `head`, `get`,
  `put`, `delete`, `list`, `createMultipartUpload`, `resumeMultipartUpload` - so that migration would
  mean streaming every object through the Worker or reintroducing the S3 credentials ADR 0012
  deliberately removed.
