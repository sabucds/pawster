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

- **A patch is not cheaper in CPU, it is strictly more expensive.** It must fetch ~33 KB, gunzip it,
  `JSON.parse` ~352 KB of text, mutate, re-serialize and re-compress. A rewrite skips the fetch, the
  gunzip and the parse and does only the serialize. The fetch a patch adds is I/O, which ADR 0016
  established Cloudflare excludes from CPU time - but the parse is not, and the 10 ms ceiling of
  ADR 0007 is the constraint the whole platform is shaped around.
- **A patch derives the index from the previous index, so a lost write is permanent.** Miss one
  delta and nothing ever notices: the animal is absent from every index built after it, forever. A
  rewrite derives the index from D1, which is the truth, so it is self-correcting by construction
  and any regeneration heals every earlier failure.
- **A patch cannot be content-addressed without doing the rewrite's work anyway**, since the key is
  a hash of the finished bytes.
- **This is ADR 0016's argument, one prefix over.** A patch is a to-delete list: cost proportional
  to churn, correctness proportional to every path remembering. A rewrite is reconciliation. The
  platform has now made this choice four times - [ADR 0009](0009-digest-delivery-and-retry.md)'s
  sent-set over a watermark, [ADR 0010](0010-subscriber-data-retention.md)'s reconciliation-based
  purges, ADR 0016's sweep, and here - and each time for the same reason: the cheap mechanism is
  cheap only while nothing goes wrong, and it fails in the direction nothing can see.

### What a regeneration costs at 2,500 animals

Measured by the issue [#17](https://github.com/sabucds/pawster/issues/17) prototype with a real
`CompressionStream('gzip')`: the index the card and the filters need is **141 B/animal raw and
33.4 KB gzipped at 2,500 animals** - about 352 KB of JSON text in, 33.4 KB of object out. A
regeneration is then:

| Step | Cost | Meter |
|---|---|---|
| Read the listable set from D1 | 2,500 rows, I/O not CPU | subrequests |
| Serialize and hash | **unmeasured** - see below | the 10 ms CPU ceiling |
| `put` the index object | ~33.4 KB | Class A, 1M/month free |
| `put` the pointer | ~100 B | Class A |
| `list i/` and delete what is superseded | a handful of keys | `list` Class A, `delete` free |

So roughly **six subrequests and four Class A operations**, against a publish path that
[ADR 0012](0012-derivatives-are-generated-once-at-upload.md) keeps near 5 of the Free plan's 50, and
against a monthly allowance three orders of magnitude above the traffic. Bytes and operations are
not the risk.

**Two numbers are unverified and must be measured, in the spirit of ADR 0007's last bullet.** The
isolate CPU of serializing and hashing 2,500 rows, against 10 ms; and whether a 2,500-row read
returns in one D1 query or has to be paged. A rewrite tolerates a paged read - it is reading the
truth either way - where a patch's arithmetic would be quietly wrong on a partial one. If the CPU
measurement comes back over budget, the fallback is stated below, and it is not a redesign.

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
2. One regeneration reads the listable set - the four-clause listing rule already excludes all 40,
   by two of its clauses independently - serializes, hashes, puts, and swings the pointer.
3. An adopter mid-session still holds the old index and still sees 40 cards. That window closes at
   their next page load, and it is not a lie the platform tells twice: the animal page is
   server-rendered from one D1 row, so an adopter who clicks a card reads the archive page saying
   the shelter has left the platform. **A card can be up to one page load stale; the page an adopter
   reads before spending a message never is.** That is exactly
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
policy on the bucket allowing the site origin - **a new provisioning step**, and the first one the
platform needs: derivatives load through `<img>`, which needs no CORS, so this read path is the
product's first cross-origin `fetch`. Moving to ADR 0014's cached Worker later changes the base URL
and nothing else.

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

- **An animal exists and is invisible.** A shelter published it, it is listed under the four-clause
  rule, and no adopter can see it. The shelter cannot tell, because a shelter sees its own animals
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

The backstop is free, and content-addressing is why: **when the catalogue has not changed, the
nightly regeneration produces identical bytes, hence an identical key, hence the same object and an
unchanged pointer.** It is a no-op by construction, with nothing to compare and no way to be wrong
about whether it was needed. It also reports for free - if the nightly pointer *changes*, a
publish-path write had been lost, which is the only drift signal the platform needs and it costs
nothing to emit.

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
  whatever fronts the bucket, and served `max-age=31536000, immutable`.
- **The pointer is `i/current.json`, `no-store`, and holds the current key.** It is the only mutable,
  uncacheable object in the read path, and the only one whose request count scales with traffic.
- **The pointer is last-write-wins, with no lock and no compare-and-swap.** Two acts regenerating at
  once means the loser's index is orphaned and the pointer may name a snapshot missing the other's
  animal - which is Index Drift, healed by the next act and bounded by the nightly run. A Durable
  Object to serialize a race that heals itself would be a new component for nothing.
- **A regeneration aborts on an incomplete read, and only on that.** If the D1 read errors or a page
  of it is missing, the pointer is not swung and the previous index stands - the same
  never-act-on-a-partial-read rail as ADR 0016. **It carries no count or percentage guard**, and the
  difference from ADR 0016 is the point: that guard exists because deletion is irreversible, while a
  regeneration is idempotent and the next one fixes it. A count guard here would buy nothing and
  would eventually refuse a lawful bulk unlist - blocking a departure from taking effect, which is
  the platform lying to adopters in the one direction it least tolerates.
- **The regenerator owns its own prefix, and reclamation's scope is unchanged.** After swinging the
  pointer it lists `i/` and deletes every index object the pointer does not name whose `uploaded` is
  more than an hour old - R2 returns `uploaded` on every listed object, so this needs no join, and
  the hour is the grace for a reader holding the old pointer that has not yet fetched its index.
  **ADR 0016's sweep still lists `d/` only.** The index is not opted into reclamation; it is kept by
  the one writer that touches it, which is also the only code that ever knows a key is superseded.
- **The nightly regeneration is a preamble step on the daily digest run, before reclamation.**
  ADR 0010 settled that a second schedule is a second thing that can die silently, so this inherits
  the Healthchecks.io watchdog and reports into the `Digest Run` summary beside reclamation's counts.
  Running before reclamation means the sweep never observes an index naming a key it is about to
  consider.
- **No cache purge is introduced anywhere in the publish path.** ADR 0012's rule survives intact, and
  now covers the index it was originally reasoning about.

## Consequences

- **`i/` holds two objects and about 67 KB**: the current index, and at most one superseded one
  awaiting its grace hour. It cannot grow monotonically, which is the whole failure ADR 0016 exists
  to close.
- **The index's read budget and the storage cap expire at almost the same moment.** At 13.7 B/animal
  gzipped, ADR 0016's ~9,500-animal endgame is a **~130 KB** index against ADR 0007's ~150 KB
  metered-connection budget. So ADR 0007's stated trigger - "when the index stops being cheap to
  download on a metered connection, filtering has to move server-side" - arrives when R2's 10 GB
  does, not before it. The index never becomes the binding constraint ahead of storage, and no
  intermediate scaling work is needed.
- **Regeneration frequency is act-shaped, not animal-shaped.** Confirmations are the platform's most
  frequent write, so they dominate: each is a full rewrite, and a nudge answered for a shelterful is
  one. Even ten thousand acts a month is ~40,000 Class A operations against 1M free.
- **A first load costs one extra round trip; every repeat load with an unchanged catalogue costs a
  hundred bytes.** What an adopter actually pays for is photos, as both prototypes found and ADR 0007
  now says.
- **CORS on `pawster-media` joins the provisioning record.** Without it the listing is empty in a way
  that looks like a broken index rather than a missing header.
- **A build session can delete the index object by hand and lose nothing.** The nightly regeneration
  rebuilds it, which is a strictly smaller blast radius than the one ADR 0016 worried about when it
  kept the index out of the sweep: there, the listing would have stayed empty until the next animal
  was published.
- **The pointer is the one place a stale read is possible, and it is a hundred bytes with
  `no-store`.** If `r2.dev`'s rate limit ever makes that request the cliff, a five-second TTL on the
  pointer is available and costs five seconds of publish-to-visible - but it is a knob, not a
  redesign, and the cached Worker is the better answer.
