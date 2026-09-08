# The filter index is rewritten whole, and found through a pointer

[ADR 0007](0007-prerender-first-and-filter-in-the-browser.md) put the listing's six filter axes in a
compact JSON index in R2 and said "publishing an animal writes a fresh index".
[ADR 0016](0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md) fixed that object under
`i/`, deliberately outside reclamation's `d/` allowlist. Neither settled the two questions a build
session hits on its first day: whether a publish **rewrites the whole index or patches it**, and how
the index object is **invalidated** once a browser or an edge has already read it.

Both are decided here, and they turn out to be one decision. **A regeneration reads the listable set
from D1 and writes the whole index; its unit is the publishing act, never the animal. The index is
content-addressed and served `immutable`, exactly as a derivative is, and a reader finds the current
one through a small stable pointer at `i/current.json`. No cache purge is introduced anywhere.**

## A regeneration is whole, because a patch is the more expensive way to be wrong

Patching looks cheaper: touch one animal, pay for one animal. It costs more in every dimension that
matters here.

- **A patch is not the CPU saving it looks like, and the case does not rest on CPU.** A patch must
  fetch ~33 KB, gunzip it, `JSON.parse` ~352 KB of text, mutate, re-serialize and re-compress. A
  rewrite skips the fetch, the gunzip and the parse - but it marshals 2,500 D1 rows into JS values
  where a patch marshals one. So the real trade is ~2,499 rows of marshalling against a gunzip plus
  a ~352 KB parse. The fetch a patch adds is I/O, which ADR 0016 established Cloudflare excludes
  from CPU time, but neither the parse nor the row marshalling is excluded, and **both sides are
  unmeasured** (measurement 1 below). The 10 ms ceiling of ADR 0007 binds whichever is chosen, so
  it does not discriminate between them: the three grounds that follow are what decide this.
- **A patch derives the index from the previous index, so a lost write is permanent.** Miss one
  delta and nothing ever notices: the animal is absent from every index built after it, forever. A
  rewrite derives the index from D1, which is the truth, so it is self-correcting by construction
  and any regeneration heals every earlier failure.
- **A patch cannot be content-addressed without doing the rewrite's work anyway**, since the key is
  a hash of the finished bytes.
- **ADR 0012 had already assumed this without arguing it.** Its photo-mutation bullet says "any
  change to the primary **rewrites** the filter index" - a rewrite, in the ordinary meaning, for a
  change that touches one field of one animal and is the strongest possible case for a patch. This
  ADR is making that word load-bearing rather than choosing against it.
- **This is ADR 0016's argument, one prefix over.** A patch is a to-delete list: cost proportional
  to churn, correctness proportional to every path remembering. A rewrite is reconciliation. The
  platform has now made this choice four times - [ADR 0009](0009-digest-delivery-and-retry.md)'s
  sent-set over a watermark, [ADR 0010](0010-subscriber-data-retention.md)'s reconciliation-based
  purges, ADR 0016's sweep, and here - and each time for the same reason: the cheap mechanism is
  cheap only while nothing goes wrong, and it fails in the direction nothing can see.

### What a regeneration costs at 2,500 animals

Measured by the issue [#17](https://github.com/sabucds/pawster/issues/17) prototype with a real
`CompressionStream('gzip')`: the index the card and the filters need is **141 B/animal raw and
33.4 KB gzipped at 2,500 animals** - about 352 KB of JSON text in, 33.4 KB of object out. The raw
figure is the per-animal one carried out linearly, and gzip compresses a larger index better rather
than worse, so every compressed number in this ADR is a ceiling. **`KB` here and throughout this
ADR is 1,000 bytes**, which is the convention every derived figure below uses. A regeneration is
then:

| Step | Cost | Meter |
|---|---|---|
| `get` the pointer | ~100 B | Class B, 10M/month free |
| Read the listable set from D1 | 2,500 rows; the wait is I/O, the marshalling is CPU | subrequests |
| Serialize and hash | **unmeasured** - see below | the 10 ms CPU ceiling |
| `put` the index object | ~33.4 KB | Class A, 1M/month free |
| `put` the pointer | ~100 B | Class A |
| `list i/` and delete what is superseded | a handful of keys | `list` Class A, `delete` free |

The pointer `get` comes first and earns its place twice: it yields the key the previous regeneration
published, which is both the drift signal below and the live reference the `i/` cleanup rule
compares against.

So **six subrequests** - one pointer `get`, one D1 read, two `put`s, one `list`, and one `delete`
that takes an array of keys, which is the batching ADR 0016's sweep already relies on - and **three
Class A operations plus one Class B**, because ADR 0016 establishes `DeleteObject` is neither Class A
nor Class B. That sits on top of a publish path
[ADR 0012](0012-derivatives-are-generated-once-at-upload.md) keeps near 5 of the Free plan's 50 -
**about 11 together**, still comfortably inside the limit - and against a monthly allowance three
orders of magnitude above the traffic. Bytes and operations are
not the risk.

**Three things are unverified and must be measured, in the spirit of ADR 0007's last bullet.**

1. **The isolate CPU of serializing and hashing 2,500 rows, against 10 ms.** This is the one that
   could change the shape of the code, and the fallback is stated below rather than being a
   redesign.
2. **Whether a 2,500-row read returns in one D1 query or has to be paged.** A rewrite tolerates a
   paged read - it is reading the truth either way - where a patch's arithmetic would be quietly
   wrong on a partial one.
3. **Whether a stored `Content-Encoding: gzip` is served back.** The decision below stores the index
   gzipped so that 33.4 KB is the wire cost whatever fronts the bucket, which assumes R2 returns the
   content encoding it was given. Nothing in this repo has verified that, and the failure is loud
   but expensive: an adopter downloading ~352 KB of uncompressed JSON blows ADR 0007's ~150 KB
   budget on the first load. **Verify it before the listing ships**, because the fallback -
   compressing per response - is Worker work on the read path, which is the thing ADR 0007 exists
   to avoid.

## The unit of regeneration is the act, not the animal

[ADR 0015](0015-a-shelter-can-leave-but-cannot-be-erased.md) introduces the platform's first bulk
unlist: a departure archives a shelter's whole roster in one act. Two more bulk acts already exist -
verifying a shelter lists its entire roster at once, since standing is a clause of the listing rule
([ADR 0003](0003-verification-is-an-append-only-log.md)), and a confirmation nudge is answered for a
shelterful in one sitting, "because animals go stale a shelterful at a time".

Per-animal regeneration would make each of these quadratic: a 40-animal roster would be 40 reads of
a 2,500-row set and 40 puts of 33.4 KB, and 39 of those 40 indexes would be a half-departed shelter
published to adopters. **So a regeneration is triggered by the act, after the D1 transaction that
the act commits, and exactly once.** A departure is one transaction archiving 40 rows, then one
regeneration reading the 2,460 that remain. Its cost is identical to a single publish's, and there
is no intermediate index for anyone to read, because there is no intermediate transaction.

Worked through against a departing shelter's roster:

1. The ceremony commits one D1 transaction: `departedAt` is set and all 40 animals are archived.
   Until it commits nothing has changed; there is no state in which 12 of the 40 are archived.
2. One regeneration reads the listable set - and a departing shelter's 40 animals fall out of it
   twice over, by the archive (`animal.state` is no longer `Available`) and by the departure clause
   (`shelter.departedAt is null` is now false) - serializes, hashes, puts, and swings the pointer.
   Either exclusion alone is sufficient and both land in the same transaction, so there is no
   ordering subtlety here. *(**The listing rule is four clauses, and this ADR settles that rather
   than noting it.** Issue [#45](https://github.com/sabucds/pawster/issues/45) - the issue that
   fixes the domain model - writes it out as `listed = animal.state == Available AND shelter has a
   Verified latest verification entry AND shelter has >=1 contact point AND shelter.departedAt is
   null`, and [#56](https://github.com/sabucds/pawster/issues/56) calls it four-clause too, while
   ADR 0015 and `CONTEXT.md`'s **Listing** entry each quoted only the first three. The spec is the
   one that is right, and ADR 0015's own reasoning needs it: departure must delist *through the
   rule*, which is exactly why that ADR adds no fourth animal state. Quoting three clauses left
   departure resting on the archive alone, and made the thirty-day contact-point erasure look like
   the clause that delists a departed shelter when it is not. **ADR 0015 and `CONTEXT.md` are both
   amended to four clauses here.**)*
3. An adopter mid-session still holds the old index and still sees 40 cards. That window closes at
   their next page load, and it is not a lie the platform tells twice: the animal page is
   server-rendered from one D1 row, so an adopter who clicks a card reads the archive page saying
   the shelter has left the platform. **A card can be up to one page load behind; the page an
   adopter reads before spending a message never is.** That is exactly
   [ADR 0001](0001-no-automatic-unlisting.md)'s calculus - a ghost costs one wasted click, and here
   it does not even cost the message.

## Invalidation: the index is a derivative

A stable key at `i/index.json` has to be invalidated somehow, and every way of doing it is closed:

- **A cache purge is forbidden.** ADR 0012 states in as many words that immutable content-addressed
  keys mean "no cache purge exists anywhere in the publish path - a purge would be Worker work and
  an API dependency", against ADR 0007's rule that the Worker runs as rarely as possible.
- **A short TTL caps publish-to-visible at the TTL** and, worse, aims the caching at the wrong
  object. [ADR 0014](0014-the-domain-is-free-and-lives-outside-cloudflare.md) serves from `r2.dev`
  today - documented as having no caching, rate-limited above "hundreds of requests/second", and
  bandwidth-throttled - and names a Workers-Cache-backed Worker as the upgrade when volume justifies
  it. Under a stable key that Worker's cache is worthless on the only object worth caching, because
  the one object it must not hold onto is the index.
- **A stable key can never be `immutable`, so a returning adopter pays for it every visit.** The
  best case is a conditional `GET` and a 304; there is no case where the answer is zero requests and
  zero bytes.

So the index takes the shape ADR 0012 already gave every other object we serve: **the key is a hash
of the index bytes, the object is served `Cache-Control: public, max-age=31536000, immutable`, and a
new index is a new key rather than a new version of an old one.** Nothing is ever invalidated,
because nothing is ever overwritten.

### Where the pointer lives, and how a reader finds it

`i/current.json`, in `pawster-media`, about a hundred bytes, `Cache-Control: no-store`:

```json
{ "key": "i/9f3ac1...4e.json", "generatedAt": "2026-09-07T04:12:08Z" }
```

The listing page is a static asset with the bucket's public base URL baked in at build time. The
island fetches `<base>/i/current.json`, then fetches the key it names. Both objects need a CORS
policy on the bucket allowing the site origin - **a new provisioning step**, recorded with its
rationale in `docs/provisioning-record.md`. Moving to ADR 0014's cached Worker later changes the
base URL and nothing else.

The pointer costs one extra round trip on a first load and repays it on every load after that. With
the catalogue unchanged, a returning adopter's index fetch is a browser cache hit on an `immutable`
object: **zero requests and zero bytes, against 33.4 KB or at best a 304 under a stable key.** On a
metered Venezuelan connection, and for an audience the digest exists to bring back weekly, that
trade is not close.

**The honest cost is request count, not bytes.** Two requests per page load instead of one, against
`r2.dev`'s undocumented rate cliff, at exactly the moment a WhatsApp share spikes traffic. The
answer is that the pointer is the request that scales with traffic and it is 100 bytes, while the
33.4 KB object becomes edge-cacheable forever the moment the cached Worker lands - where a stable
key would pull 33.4 KB from a bandwidth-throttled bucket on every load, permanently. ADR 0014's rate
limit stays the trigger to build that Worker, and this decision is what makes the Worker worth
building.

## Index Drift, and why it is regenerated rather than repaired

Derivative immutability means an adopter reading mid-write provably gets a coherent *old* index, so
the interesting failure is not a torn read. It is the D1 write succeeding while the index write does
not. Name it **Index Drift**: the index disagrees with D1, in one of two directions.

- **An animal exists and is invisible.** A shelter published it, the listing rule says it is listed,
  and no adopter can see it. The shelter cannot tell, because a shelter sees its own animals
  through its session, from D1.
- **An unlisted animal is still on a card.** The dangerous direction: a departed shelter's roster,
  or a revoked shelter's, still published to adopters. Bounded, as above, by the detail page being
  server-rendered from D1.

**There is no repair queue and no `index_dirty` row.** A row like that is ADR 0016's tombstone again
- it needs a writer at the moment of failure, which is the moment least likely to have one, and a
missed path leaks silently. The index is a pure function of D1, so drift is not repaired, it is
regenerated away. Three things regenerate:

1. **The failing act retries the `put` once inline** - it is I/O, so it is affordable - and if it
   still fails, tells the shelter the truth: the animal is saved, the listing follows.
2. **The shelter's next act of any kind** - another publish, a photo change, a confirmation - which
   is a full rewrite from D1 and therefore heals the earlier loss without knowing it happened.
3. **An unconditional regeneration in the daily digest run's preamble**, which bounds any drift at
   one run.

The backstop costs no storage and no new object, and content-addressing is why: **when nothing
listed has changed, the nightly regeneration produces identical bytes, hence an identical key, hence
a `put` over the object that is already there and a pointer that goes on naming it.** It is a no-op
in the only dimension that accumulates, with nothing to compare and no way to be wrong about whether
it was needed. It is not literally free - it still spends the six subrequests above, once a day,
against allowances three orders of magnitude larger - and that is the whole price of never needing
to decide whether a regeneration was necessary.

**That idempotence is a property of the bytes, so the bytes have to be deterministic, and one line
of SQL is what buys it.** The read carries an explicit `ORDER BY` on the animal id. Without it the
row order is whatever D1 returns, two runs over identical data serialize differently, every nightly
run mints a new key, and the free no-op quietly becomes a nightly write plus an orphan. Ordering
for *display* is not this decision's business: issue #56 sorts freshest-confirmed-first in the
browser, over the index it downloaded.

It also reports drift at no extra cost, and the signal is the key rather than the pointer: **if the
nightly run lands on a key that differs from the one the pointer already named, a publish-path write
had been lost.** That comparison is why the regeneration opens with a `get` of the pointer, costed in
the table above. The pointer's own bytes carry `generatedAt` and therefore change every run, so the
pointer changing means nothing; the key changing is the whole signal, and it is the only drift
detection the platform needs.

## The decision

- **A regeneration reads the listable set from D1 and writes the whole index.** Never a patch, never
  a delta, never derived from a previous index.
- **Its unit is the act.** One publish, one departure, one verification, one nudge answered for a
  shelterful: one regeneration each, after the transaction commits.
- **It is synchronous, in the request path, and the last step.** Publish-to-visible stays the
  "seconds, not a rebuild" ADR 0007 promised, and the failure surfaces to the actor who caused it.
  *If the measurement above puts serialize-and-hash over the CPU ceiling, regeneration moves to a
  message on the queue `digest/` already consumes - a seam that exists rather than a new component.
  That does not reopen the async regeneration ADR 0012 rejected: that rejection was about an index
  naming a derivative that does not exist yet, and derivatives are written before the animal row, so
  a queued regeneration can only ever name keys that already exist. It costs a few more seconds of
  invisibility and nothing else.*
- **The index object is content-addressed and immutable.** `i/<hash>.json`, hashed over the
  serialized JSON bytes, stored gzipped with `Content-Encoding: gzip` so 33.4 KB is the wire cost
  whatever fronts the bucket - subject to the third measurement above - and served
  `max-age=31536000, immutable`.
- **The read carries an explicit `ORDER BY` on the animal id.** Content-addressing is only
  idempotent if identical data serializes to identical bytes, and an unordered read does not. This
  is one line of SQL holding up the free nightly no-op; display order is the browser's, per #56.
- **The pointer is `i/current.json`, `no-store`, and holds the current key.** It is the only mutable,
  uncacheable object in the read path, and the only one whose request count scales with traffic.
- **The pointer is last-write-wins, with no lock and no compare-and-swap.** Two acts regenerating at
  once means the loser's index is orphaned and the pointer may name an index built from a read of
  D1 taken before the other act committed - which is Index Drift, healed by the next act and
  bounded by the nightly run. A Durable Object to serialize a race that heals itself would be a new
  component for nothing.
- **A regeneration aborts on an incomplete read, and only on that.** If the D1 read errors, or a
  paged read does not run to a clean end of its cursor, the pointer is not swung and the previous
  index stands - the same never-act-on-a-partial-read rail as ADR 0016. **Incompleteness is detected
  from the read's own contract** - an error, or a cursor that never reports itself exhausted - and
  never by comparing the row count against what was there last time, which is the distinction from
  ADR 0016's guard rather than a contradiction of it. **So it carries no count or percentage
  guard**: that guard exists because deletion is irreversible, while a regeneration is idempotent
  and the next one fixes it. A count guard here would buy nothing detection does not already give,
  and would eventually refuse a lawful bulk unlist - blocking a departure from taking effect, which
  is the platform lying to adopters in the one direction it least tolerates.
- **The regenerator owns its own prefix, and reclamation's scope is unchanged.** After swinging the
  pointer it lists `i/` and deletes every object there that **is not `i/current.json`**, is not the
  key the pointer names, and whose `uploaded` is more than an hour old. All three conditions are
  load-bearing: the pointer lives in the same prefix and a rule phrased only as "what the pointer
  does not name" would delete the pointer itself on the first run; and the hour is the grace for a
  reader that holds the pointer and has not yet fetched the index it names. That gap is the two
  fetches of one page load - seconds at worst on a bad connection - so an hour is three orders of
  magnitude of headroom, chosen to be obviously enough rather than tuned. R2 returns `uploaded` on
  every listed object, so the age test needs no join - the same idiom as ADR 0016's third condition.
  **ADR 0016's sweep still lists `d/` only**, and the index is not opted into it.
- **That prefix-keeping is reconciliation too, which is why it does not contradict Reclamation.**
  `CONTEXT.md` defines Reclamation as how storage comes back "whatever left it behind - so no path
  has to remember to clean up after itself", and a writer tidying its own prefix looks exactly like
  the path that has to remember. It is not, and the distinguishing property is the one that mattered
  in ADR 0016: this is a `list` compared against a live reference, not a tombstone written at the
  moment of unreferencing. If a run dies before deleting, the next run lists `i/` again and collects
  what was missed; nothing has to have been recorded. The reason it lives with the regenerator
  rather than with the nightly sweep is that `i/` has exactly one reference - the pointer - and
  exactly one writer, which is holding that reference in its hand at the moment it swings it.
  Reclamation reads every animal in the platform to establish its reference set; this reads one
  small file.
- **The nightly regeneration is a preamble step on the daily digest run, before reclamation.**
  ADR 0010 settled that a second schedule is a second thing that can die silently, so this inherits
  the Healthchecks.io watchdog and reports into the `Digest Run` summary beside reclamation's counts.
  **Running before reclamation is about what the index names, not about what the sweep sees.** The
  sweep never reads the index in either order - its reference set is every animal in D1, per
  ADR 0016. But the index carries thumbnail keys under `d/`, so a drifted index can name a
  derivative that D1 no longer references and the sweep is about to delete. Regenerating first
  collapses that drift before the sweep computes its reference set, so the index the pointer names
  references only keys D1 still does, and no adopter is handed an index pointing at bytes that were
  reclaimed the same night.
- **No cache purge is introduced anywhere in the publish path.** ADR 0012's rule survives intact, and
  now covers the index it was originally reasoning about.

## Consequences

- **`i/` holds the pointer, the current index, and every index superseded within the last hour.**
  Not "two objects": a busy hour is a busy hour, and ten acts in one leave ten objects of ~33 KB
  until the next regeneration clears the ones that have aged out. What matters is that the bound is
  an hour of acts rather than all of history - `i/` cannot grow monotonically, which is the failure
  ADR 0016 exists to close. A quiet platform settles at **about 33.5 KB** - the pointer and one
  index - once the last superseded object has aged past the hour and a regeneration has collected
  it. Between a lone act and the next regeneration it is double that, which is the honest worst case
  for a quiet platform rather than its resting state.
- **The index's read budget and the storage cap expire at almost the same moment.** At 13.4 B/animal
  gzipped, a ~9,500-animal endgame is a **~127 KB** index against ADR 0007's ~150 KB
  metered-connection budget. That animal figure is ADR 0012's, and ADR 0016 calls it optimistic by
  about a gigabyte's worth - which only strengthens this conclusion, since a lower real ceiling is a
  smaller index. So ADR 0007's stated trigger - "when the index stops being cheap to download on a
  metered connection, filtering has to move server-side" - arrives when R2's 10 GB does, not before
  it. The index never becomes the binding constraint ahead of storage, and no intermediate scaling
  work is needed.

  > **Measured, and this bullet's conclusion does not survive it.** Issue #56 shipped the index and
  > `npm run check:filter-index` re-derives its size from the serializer that writes it: **20.4
  > B/animal gzipped, not 13.4**, so 9,500 animals is **187.4 KB** and ADR 0007's budget is crossed
  > at about **7,578**. The index expires *first*, not "at almost the same moment".
  >
  > The gap is identifiers, and it is the whole of it. Both figures above come from the issue #17
  > prototype, which synthesised 4-character animal ids, 3-character shelter ids and a thumbnail
  > key of `id + "-1"`. The rows the platform writes carry two `crypto.randomUUID()`s and a
  > content-addressed derivative key of `d/` plus a 64-character hex digest (ADR 0012) - about 105
  > high-entropy characters an animal that gzip cannot fold away and that no prototype counted.
  >
  > **Nothing is reopened here, because the number does not bind yet.** At the 2,500 listed animals
  > this ADR spends its own arithmetic on, the index is 51.0 KB - a third of the budget. And 9,500
  > was already the optimistic figure ADR 0016 discounts. What has moved is *when* ADR 0007's
  > trigger fires: around 7,600 listed animals rather than never. The full reasoning, and the
  > cheapest lever if it ever does bind, are in [`measurements.md`](../measurements.md#filter-index-size).
- **Regeneration frequency is act-shaped, not animal-shaped.** Confirmations are the platform's most
  frequent write, so they dominate: each is a full rewrite, and a nudge answered for a shelterful is
  one. Even ten thousand acts a month is ~30,000 Class A operations against 1M free.
- **A first load costs one extra round trip; every repeat load with an unchanged catalogue costs a
  hundred bytes.** What an adopter actually pays for is photos, as both prototypes found and ADR 0007
  now says.
- **CORS on `pawster-media` joins the provisioning record.** Without it the listing is empty in a way
  that looks like a broken index rather than a missing header.
- **The pointer is the only object in the read path that can be served out of date, and it is a
  hundred bytes with `no-store`.** Note that a short TTL on it is not a knob available today:
  `r2.dev` caches nothing at all (ADR 0014), so `no-store` versus five seconds makes no difference
  to what an adopter gets. It becomes a knob only behind ADR 0014's cached Worker, where it would
  trade five seconds of publish-to-visible for one cached request in five seconds - and by then the
  33.4 KB index is being served from that cache, which is the win worth having.
