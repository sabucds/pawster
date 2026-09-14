# An animal's address is a short id with a decorative name, and it never 404s

An animal's page is the only address Pawster ever hands to a stranger. It arrives by WhatsApp
forward from a shelter's status, it is retyped off a screenshot, and it is quoted back inside the
prefilled message the adopter sends — so it is read by people far more than it is followed by
machines. Two facts about the domain then fix its shape.

**Shelters rename animals constantly.** A Callejero becomes a Luna the week she is fostered, and
`db/`'s `animals` table already has no slug column because of it: the animal's id "is the animal's
whole public address [...] which is what makes the name freely renameable". An address that
resolved on the name would break weekly.

**An animal is never deleted.** `CONTEXT.md` defines an *Archive* as "the retained record of an
animal that has left the listing", whose "page stays reachable and says what happened", and
[ADR 0015](0015-a-shelter-can-leave-but-cannot-be-erased.md) keeps a departed shelter's archive
pages precisely "because the archive is a promise made to adopters rather than to the shelter". A
dead link is the one outcome ruled out.

So: **the address is `/a/<short id>/<name>`, only the id resolves, and the route answers a page
for every animal a verified shelter ever published.**

## The address

`/a/7f3k9mqp/luna`, and `/a/7f3k9mqp`, and `/a/7f3k9mqp/callejero` are one page. The trailing
segment is the animal's name transliterated to a slug, it is read by nothing, and a name that
strips to nothing (an animal called `🐕`) simply has no segment. The page declares a
`<link rel="canonical">` at the current spelling, because a route that answers to arbitrarily many
URLs owes a search engine exactly one of them.

The id is **eight symbols over a 32-character alphabet** — lower-case digits and letters minus
`0`, `1`, `l` and `o`, the two pairs a human transcribes wrong. It replaces the UUID
`publishAnimal()` used to mint. The column is `text` either way, so nothing migrates and animals
published before this keep the address they were given, which is the entire point of an address.

**Why eight.** `npm run check:short-id` prints the arithmetic and checks the draw; it is
reproducible rather than remembered, and it re-derives itself if the length changes:

| animals | p(next publish collides) | p(any collision, ever) |
|---|---|---|
| 1,000 | 9.09 × 10⁻¹⁰ | 4.54 × 10⁻⁷ |
| 2,500 | 2.27 × 10⁻⁹ | 2.84 × 10⁻⁶ |
| 10,000 | 9.09 × 10⁻⁹ | 4.55 × 10⁻⁵ |
| 100,000 | 9.09 × 10⁻⁸ | 4.54 × 10⁻³ |

2,500 is the population the filter-index measurements assume; 10,000 is four times that. At that
size a collision across the platform's whole life is a 1-in-20,000 event, which is why **there is
no retry loop**: the primary key is the guard, a collision surfaces as a publish the shelter can
repeat, and a recovery path that runs once a millennium is a path that is wrong when it finally
runs.

The same script checks that the generator draws uniformly — 16 million symbols, chi-squared 25.2
on 31 degrees of freedom against a critical value of 62.49. That is not ceremony: 32 symbols is
exactly a byte's low five bits, and the reason the alphabet is 32 rather than a friendlier 36 or
62 is that anything not dividing 256 needs rejection sampling, whose absence is invisible in an
id and shows up only as a collision rate higher than the table above.

**Guessability sets none of this.** Every other random value on the platform is sized against an
attacker; this one is not. An animal page is public and the listing enumerates it anyway, so
there is nothing behind the address to guess into.

## What the route answers, and the one thing it refuses

`domain/`'s `isListed()` has four clauses. Three of them produce an archive page and one produces
nothing, and the asymmetry is the decision here rather than an implementation detail.

| Why it is not listed | What the adopter gets |
|---|---|
| `Adopted` | 200 — *Encontró casa*, attributed to the shelter |
| `NoLongerAvailable` | 200 — worded without a story attached |
| The shelter departed (ADR 0015) | 200 — the shelter is gone, so nobody can be put in touch |
| The shelter offers no contact point | 200 — the same, without the departure |
| **The shelter is not verified** | **404** |

**Verification is the one that refuses**, for two different reasons that happen to agree.

*Pending or refused*: the animal was never publicly reachable, so there is no promise to an
adopter to keep. Issue #55 made this a 404 exactly so that a page cannot leak both that the id is
real and that the shelter is unverified, and an archive page would leak both.

*Revoked*: `CONTEXT.md` is explicit that a Revocation delists a shelter's animals **"without
archiving them"**. The platform has withdrawn its judgement about that shelter; continuing to
publish pages under it — even pages saying the animal is gone — is the platform still vouching.

So the promise is precise: **once a shelter is verified, every animal it has published has a page
for as long as Pawster exists.** `web/src/lib/animals/visibility.ts` holds the rule, and its test
asserts the property that keeps it honest — it answers *listed* for exactly the facts
`isListed()` answers `true` for, across all 48 combinations, so a fifth clause added there fails
here rather than quietly producing an archive page with no wording for it.

## Considered options

**Keep the UUID.** Free, and it was already the address. Rejected on the one place the length is
actually paid: the prefilled message. `Hola, les escribo por Luna
(pawster.dpdns.org/a/7f3k9mqp)` is a sentence a person sends; the same sentence with 36
characters of hex in it is one they edit the address out of, and the address is the only thing
that tells the shelter which animal they mean.

**A four-character id**, as the public-listing prototype's seed data used. Rejected on the table
above: 32⁴ is a million, and 2,500 animals collide with probability ~0.3%. Not fatal with a retry
loop, and the retry loop is the cost — four characters buys back four keystrokes and pays for
them with a code path that is exercised once a year and therefore broken.

**A separate `short_id` column beside the UUID.** Rejected because it gives every animal two
public addresses, and this whole design rests on it having one. Two addresses is two things to
canonicalise, two things a prefill could quote, and eventually two things that disagree.

**Slug on the name, with the id as a tie-break** — the shape most listing sites use. Rejected by
the rename rate: every renamed animal either breaks its old URL or acquires a permanent redirect,
and this platform would accumulate those weekly.

**404 the delisted animals and keep the archive for adopted ones only.** Rejected because "which
of the four clauses fired" is not something an adopter knows or should have to; a dead link
teaches them the platform loses animals. The one exception is the verification clause above, and
it is an exception about *what was ever public* rather than about tidiness.

## Consequences

- **`/animales/<id>` is gone rather than redirected.** Pawster has never been deployed — issue
  #67 is the first deploy — so that URL is one nobody holds, and a permanent redirect would have
  created the second address this ADR just refused. The route was issue #55's stub.
- **The route is server-rendered**, one of the three exceptions to
  [ADR 0007](0007-prerender-first-and-filter-in-the-browser.md)'s prerender-first rule.
  Prerendering a page per animal makes every publish, edit and confirmation a site rebuild, and
  there is no build to trigger at 3am when a shelter answers a nudge. Measured at **2.4–2.7 ms
  against the 10 ms ceiling** (`docs/measurements.md`), up 2.5× from the stub it replaced.
- **The archive page must render with no photographs at all**, because photos drop on the
  ordinary twelve-month clock and an archived animal outlives them. It says so rather than
  leaving a gap that reads as broken.
- **A social preview is part of the address.** Sharing is how a listing spreads here, so the page
  emits the Open Graph trio WhatsApp actually reads, pointing at the 1200×630 JPEG derivative
  generated once at upload ([ADR 0012](0012-derivatives-are-generated-once-at-upload.md)) and
  served straight from R2 with no Worker in the path
  ([ADR 0014](0014-the-domain-is-free-and-lives-outside-cloudflare.md)).
- **Nothing may be inferred from an id.** It is random, so it sorts arbitrarily, reveals no
  publication order and cannot be counted. Anything wanting insertion order reads
  `matchableSince`, which is a column that means it.
- **Bonded groups will need an address of their own** (issue #59). A group is an Adoption Unit
  with no name and no description, so `/a/<id>/<name>` describes one member of it; that ticket
  decides whether a group is a third path shape or an id in the same space.
