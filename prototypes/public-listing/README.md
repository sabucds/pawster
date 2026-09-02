# Prototype: the public listing and the animal page on a phone, in Spanish

> **Verdict: A — Mosaico 2×, with a fixed-height card.** Staleness is a **uniform provenance line
> on every card, fresh included**, with the caution wording kept for the animal page; a bonded
> group is a **photo strip plus one composition line and no per-member facts**; the good-with flags
> get **three visual weights, not one tri-state chip row**; urgency is a **chip on the card and its
> note on the page**. Contact is **primary + rest**, keyed off the shelter's own ordering.
> B and C are kept here as the primary source of that decision — C remains the shape to fall back
> to if photo payload ever binds. Full reasoning on
> [issue #17](https://github.com/sabucds/pawster/issues/17).

Throwaway. Not production code — no tests, no error handling, no abstractions. The real pages will
live in `web/src/pages` per the topology in [#9](https://github.com/sabucds/pawster/issues/9); this
will not.

**Open `index.html` by double-clicking.** Nothing to install, no build step, no network.

## What it is

Two screens — the public listing and one animal page — each in three structurally different
variants, rendered inside an iframe at a real 360px so `position: sticky`, scrolling and media
queries behave as they would on a handset. Switch with the floating bottom bar, the left/right
arrow keys (variant) or up/down (screen).

| | Variant | The end of the question it tested |
|---|---|---|
| **Listado** | A — Mosaico 2× | Two cards a row, 4:5 photo. Does a gallery survive when the meta is what decides? |
| | B — Tarjeta ancha | One full-width 4:3 card a row, whole meta stack. Room for everything — at what price? |
| | C — Filas | 96px thumbnail left, text right: the shape [#15](https://github.com/sabucds/pawster/issues/15) chose for the digest. Does it still work when the reader has *not* opted in? |
| **Ficha** | A — Galería primero | Swipeable photo strip, contact at the very end. |
| | B — Datos primero | One photo, facts, description, sticky contact bar. |
| | C — Héroe + CTA fija | Full-bleed hero, description first, facts folded away, contact always on screen. |

Each of the four unresolved things also has its **own toggle**, so a treatment can be judged apart
from the variant it happens to be sitting in: staleness (uniform line / badge-when-bad / page
only), convivencia (three chips / graduated / known-only), bonded (photo strip / stacked +N / text
only), urgency (chip / banner / page only), contact (primary+rest / equal row / sheet). Plus
es-VE ↔ English, 320–430px, photos loaded/loading/blocked, light/dark, and a **Ficha de** picker
for the edge cases (normal, urgent, bonded group, and Coco — stale *and* all-unknown *and* a
dormant shelter with four contact points).

Every control is reflected in the URL, so a specific view is shareable.

## Measured, not guessed

Scroll heights and DOM counts are read out of the browser; the filter index is compressed with a
real `CompressionStream('gzip')`. Photo payload uses #15's WebP formula (`w × h × 0.17 + 800`) so
the two prototypes are comparable. All figures are the same 14 seed animals → **12 cards** (one
bonded group of three collapses to one card).

| Listing variant | Scroll, 12 cards | Screens @360×760 | Derivative | Photo payload |
|---|---|---|---|---|
| A — Mosaico 2× | 2,274 px | 3.0 | 344×430 | 304 KB |
| B — Tarjeta ancha | 4,779 px | 6.3 | 688×516 | **717 KB** |
| C — Filas | **1,678 px** | **2.2** | 192×192 | **83 KB** |

| Filter index, 2,500 animals | Raw | Gzipped |
|---|---|---|
| Filter axes only (the floor — every axis must be there to filter in the browser) | 112 B/animal | 21.6 KB |
| **+ what the card needs** (`lastConfirmedAt`, bonded id, urgency flag, shelter id) | 141 B/animal | **33.4 KB** |
| + urgency notes inlined as text | 149 B/animal | 35.5 KB |
| + shelter and member names inlined as text | 178 B/animal | 38.6 KB |

Three findings fell out of that.

- **The filter index is not the constraint, and ADR 0007 says it is.** That ADR calls the index
  "a page-weight budget, and the thing to watch". Measured, the whole thing is **33 KB gzipped at
  2,500 animals**, and even the most wasteful field set reaches 38 KB — against a 150 KB budget for
  a metered connection. Everything the card wants *beyond* filtering costs 12 KB across 2,500
  animals. So **the card's field budget is a legibility decision, not a payload one.** This is the
  same inversion #15 found with Gmail clipping, and it lands on the same real constraint.
- **The constraint is photos, again, and it is 8.6× between variants** — 83 KB against 717 KB for
  the same twelve animals, bought entirely by derivative size. Photo count and dimensions, not
  markup and not data, are what a Venezuelan adopter on mobile data pays for. This is now a
  requirement on [#19](https://github.com/sabucds/pawster/issues/19): the listing needs a small
  square derivative *and* a card derivative, and which ones depends on the card shape below.
- **Spanish did not break the layout — it broke the string table.** The ticket assumed es-VE, being
  the longer language, was the layout risk. On the card's dense meta line it is **~22% shorter**
  (avg 17.1 chars vs English's 21.9; longest 22 vs 27), because `Perra adulta` collapses species,
  sex and life stage into two words where English needs `Adult dog · Female`. `scrollWidth` never
  exceeded the viewport at 320px or 360px. What Spanish actually costs is grammatical: see
  [i18n](#what-this-says-about-i18n).

Two more measurements worth keeping:

- **Photos blocked and photos loaded give an identical document height** (4,779 px both), because
  every photo box is reserved by its `width`/`height` attributes. No layout shift on a patchy
  connection — which is the whole point of keeping those attributes.
- **The three-chips treatment costs +14% scroll for strictly less information** (1,916 px vs
  1,678 px in variant C) — and the badge-only staleness treatment is *taller* than the uniform
  line it was meant to be cheaper than (4,938 px vs 4,779 px).

## The four things, resolved

### Staleness — a uniform line, and the caution only on the page

**The card prints the same line on every animal, fresh ones included**, in the same position and
the same phrasing, with only the duration changing: `Miranda · Confirmada ayer`,
`Aragua · Confirmado hace 4 meses`. Colour shifts to amber past 30 days; nothing else changes.

The reason is the one the ticket was circling: **if the line appears only when there is something
wrong, its presence is the warning.** A badge that shows up on ageing animals and nowhere else is
read as "don't bother", however neutrally it is worded — and it measured taller than the honest
line anyway. What makes the neutral label affordable is that **the sort order is already doing the
de-emphasising**: ADR 0001 gives staleness the ordering, freshest first, so a stale animal has
already sunk by the time an adopter reads its label. The label does not need to do that job twice.

The **animal page** then says the thing the card must not: `Confirmado hace 4 meses por el
refugio. Puede que ya no esté disponible.` That split is the actual resolution — **the card states
a fact, the page states the consequence** — and it works because the page is where an adopter is
about to spend a message, not where they are scanning twelve animals.

> **ADR 0001 never fixed the band thresholds.** It fixed the shape (derived, display-only) and
> named the bands, but not the numbers. This prototype assumes **fresh ≤ 30 days, ageing 31–90,
> stale > 90**, taking 30 from the confirmation nudge's cadence and 90 from the dormancy line. That
> needs recording either way.

### Bonded groups — a photo strip, one composition line, no per-member facts

The card shows a **strip of member photos**, not one photo with a "+2" badge. The strip reads
immediately as *more than one animal*, which is the surprise the card exists to prevent; the badge
reads as *more photos of this animal*, which is worse than saying nothing. Then exactly one
composition line: **a count, a species and the spread of age bands** —
`⚭ Se adoptan juntos · 3 perros · 1 adulta y 2 cachorros`.

Composition is not the members' attributes. #11 requires the card to "show the whole composition so
nobody is surprised", and the temptation is to read that as three mini-cards; that is precisely what
turns one card into a second listing page. Count + species + band spread discharges the obligation
in one line. The names live in the heading, so **the composition line must not repeat them** — it
did in the first draft and it read as stuttering.

Three consequences of the model only became visible on the **animal page**, and all three are real:

- **The heading cannot borrow the primary member's meta line.** `Perra adulta · Mediana` under a
  title reading *Mora, Nube y Panita* describes one third of what is on offer, and contradicts the
  composition line beside it.
- **A group cannot share one facts table.** Age, adult size and sterilisation are per-animal, and
  #11 matches descriptive axes on the *union* — so a table showing the primary member's row is
  simply wrong for every mother-plus-pups group. Only **region and last-confirmed** are genuinely
  group-level (confirmation applies to the whole group by #11). The rest moved into the member list,
  where the differences that matter — `unos 3 años · Esterilizada` against
  `unos 3 meses · Sin esterilizar` — are visible.
- **Every name-interpolating string needs a group form.** A bonded group has no name and no
  description of its own, so `Sobre Mora` is wrong on a page titled *Mora, Nube y Panita*, and —
  the one that would have cost a real adoption — **the WhatsApp prefill has to name every member.**
  "Hola, les escribo por Mora" asks the shelter for one puppy when the adopter means all three.

### Unknown good-with flags — three weights, not one chip row

The three flags are **not one visual class**, and treating them as a tri-state chip row is exactly
what produces the wall. They get three weights:

| | Treatment | Why |
|---|---|---|
| Known **No** | A legible warning chip — `No convive con gatos` | It is a safety fact, and the filter excludes *only* an explicit No, so someone browsing unfiltered must see it. |
| Known **Yes** | A quiet positive chip, merged when there are several — `Con niños y gatos` | Useful, not urgent. Merging keeps it to one line. |
| **Unknown** | Collapsed into one named line — `Sin evaluar: perros`, or `Convivencia sin evaluar` when all three are | Still labelled, as #11 requires — just once, collectively, instead of three times. |

Turn the toggle to **tres chips** to see what the ticket was worried about: four of the twelve cards
carry three stacked `no se sabe` chips as the visually heaviest element on the card, and Manchas's
two genuine `No`s get the same weight as non-information. It costs +14% scroll to say less.

The **animal page** states all three flags explicitly, `no se sabe` included, because it has the
room and because a shelter's honest "not assessed" is worth reading before you write.

### Urgency — a chip on the card, the note on the page

A chip beside the name, and the required note on the animal page. Not a banner.

The reason is structural rather than aesthetic: **the cap is three per shelter and the listing is
cross-shelter**, so the platform can cap urgency per shelter but *not per screen*. A banner is
defensible when one animal on screen has it and degrades to noise the moment several shelters use
their allowance — and the seed data has two urgent animals in twelve cards, which is not a
pessimistic assumption. Measured, the banner adds 185 px and makes urgency the loudest thing on the
card, above the safety flags, which is the wrong ordering. And urgency is **not a sort key**;
ADR 0001 gives the ordering to staleness, and a per-shelter cap plus urgency-first sorting would let
a handful of shelters own the first screen.

### Contact — primary + rest, from the shelter's own ordering

Contact points are a **typed, ordered set** (#11), which means the shelter has already told us which
channel it wants used. So: **one filled primary button for the first contact point, a compact
secondary row for the rest.** No coin-flip, no picker for the common case.

The alternatives both cost something the toggle makes visible. An **equal row of four** hands the
adopter a decision they have no basis for — nothing on it says which channel actually gets answered
— and Fundación Cuatro Patas, with four points, renders as a 2×2 grid of identical buttons. A
**sheet** costs an extra tap for what will be the ~90% WhatsApp case.

Two things fell out of building it:

- **The sticky bar carries the primary button and nothing else.** The first draft put the secondary
  row, the prefill preview and the off-platform line in it, and it ate **250 px of a 760 px
  viewport** — a third of the screen, permanently. The rest belongs in the flow.
- **The CTA is not just a link; it is the only join between the platform and the conversation.**
  It carries a prefilled message naming the animal and its short id —
  `Hola, les escribo por Coco (pawster.org/a/m6p2). ¿Sigue disponible?` — because contact is
  off-platform and otherwise the shelter cannot tell which animal a message is about. It is also
  the only place a future ghost-report or adoption-attribution signal could hook onto.

## The field budget

**On the listing card:** primary photo · name · urgency chip · one meta line
(`Perra adulta · Mediana`) · one line of region + last-confirmed · one convivencia line · one
composition line for groups.

**On the animal page, and only there:** description · the rest of the photos · precise age *with
its basis* (`unos 10 meses (estimada por el refugio)`, so a shelter guess never reads as a
birthday) · adult size restated as the prediction it is · sterilisation · medical needs · all three
good-with flags explicitly · shelter, its verification badge and any dormancy notice · contact.

Two deliberate exclusions from the card:

- **The shelter name.** Verification is a precondition for listing, so every listed animal's
  shelter is verified — the name adds provenance but changes no shortlisting decision, and *region*
  already answers the question an adopter is actually asking, which is where they would collect the
  animal.
- **Sterilisation.** Prominent in Venezuelan adoption and kept prominent on the page, but it
  changes the conversation rather than the shortlist.

The page's facts table also **drops what the heading already says**. Species, life stage and sex are
all carried by `Perra adulta · Mediana` directly above it; restating them was three duplications.
Adult size stays, because a bare `Mediana` does not say that for a puppy it is a prediction.

## The card shape — settled on A

The measurements ruled out **B** outright: 6.3 screens and 717 KB for twelve animals is
indefensible on a metered connection. Between **A** (3.0 screens, 304 KB) and **C** (2.2 screens,
83 KB) the numbers are close, and the choice turned on something placeholder rectangles cannot
answer — whether a 344×430 photo converts a stranger where a 96px thumbnail does not.

**A won**, on the grounds that the listing's job is not the digest's. #15 chose rows and accepted
explicitly that the digest "carries nothing of an animal's character" — an affordable trade for a
reader who already subscribed, and a bad one for someone arriving cold from a shelter's Instagram
post, where the photo is the entire reason they keep scrolling. C stays the shape to fall back to
if photo payload becomes binding, which is why it is retained here rather than deleted.

**A has one real defect, and it is fixable:** a 2-up grid makes every row as tall as its tallest
card, and this data is intrinsically variable-height — nought to three convivencia chip lines, an
optional composition line, and a group's photo strip that is shorter than a neighbouring 4:5 photo.
The result is visible in the third row, where Rayo's text block and the group's start at completely
different heights. It needs a **fixed two-line reservation** for the convivencia slot (enough for
the worst case in the seed data: two `No`s plus a `Yes`) and a strip whose height matches the single
photo it sits beside. Note what that costs: making the grid uniform means committing to a fixed
field set, which is the field-budget decision above, enforced by the layout rather than chosen.

`?variant=A` against `?variant=C` at `?screen=listado` is the comparison that settled it, and is
worth re-running against real photos before the build commits to the derivative sizes.

## What this says about i18n

The still-open i18n architecture item picks up three constraints from this, none of them about
string length:

- **Labels need grammatical gender agreement driven by the animal's sex.** `Perra adulta` /
  `Perro adulto`, `Confirmada` / `Confirmado`, `Esterilizada` / `Sin esterilizar`,
  `Pequeña` / `Pequeño`. A flat key→string table cannot express this; the prototype carries
  `{masculine, feminine}` pairs and a `G(pair, sex)` helper, which is the minimum shape.
- **The Baby band word is itself a species noun** in both languages — `cachorra`, `gatica`,
  `puppy`, `kitten` — so composing species + band double-names the animal. The first render said
  **`Gata gatica`**. For that band the band word has to replace the species word.
- **`CONTEXT.md`'s _Avoid_ lists are monolingual.** `refugio` sits on Shelter's avoid list, but it
  is the only natural es-VE word and the UI must use it. The avoid lists govern the English
  codebase vocabulary; the glossary wants an es-VE column, or a line saying so.

## One bug this caught, which the real build must not repeat

`img { max-width: 100% }` **without `height: auto`** makes an `<img>` carrying `width`/`height`
attributes ignore the `aspect-ratio` on its box: a 688×516 photo rendered 360×516, stretched and
oversized, and every card was ~40% too tall. The attributes have to stay — they are what reserves
the box before the bytes arrive, and the measurement above shows that is what keeps a blocked or
slow photo from shifting the layout. So `height: auto` is required *alongside* them, not instead.

The first draft of the sort also ran backwards and led the listing with the **stalest** animals,
which is worth knowing given ADR 0001 hands the ordering real weight: freshest-first is the
incentive that makes the monthly nudge worth answering, and the comparator that delivers it is one
character away from the one that inverts it.

## Caveats, stated honestly

- **Photos are generated placeholder SVGs.** They test size and position on the card, not whether a
  real photo of a real street dog out-pulls the text beside it — which is exactly why the A-vs-C
  choice is left to a human eye rather than settled here. Same caveat as #15, and the same reason.
- **Image byte figures are a formula, not measurements of real derivatives**, carried over from #15
  for comparability.
- **The staleness thresholds are assumed**, not decided (see above).
- **The filter UI is drawn, not designed.** The sticky filter row and `Filtros (2)` exist so the
  cards are judged inside real chrome rather than in a vacuum; six-axis filtering at 360px was not
  prototyped and is arguably its own ticket.
- **The index synthesis reuses 14 seed animals' structure**, injecting entropy where real data has
  it (names, shelter assignment, one distinct urgency note per urgent animal, capped at 3 per
  shelter). Without that injection gzip flattered every inline-the-string option; with it the
  numbers still say the index is nowhere near binding.
- **Dark mode is theme-toggled here**, and unlike the digest there is no third-party client to
  force-invert it, so it is more trustworthy than #15's — but it has still never been on a handset.

## Vocabulary

Follows `CONTEXT.md` and the model settled in [#11](https://github.com/sabucds/pawster/issues/11):
closed platform-owned axis vocabularies, dog-only size meaning expected adult size, good-with flags
with an explicit unknown that is labelled rather than hidden, bonded groups rendered as one unit
matching on the intersection of safety axes and the union of descriptive ones, urgency as a capped
flag carrying its written reason, and photos 1–6 with the first primary.

**Age bands and staleness are derived at render time here**, from `estimatedBirthDate` and
`lastConfirmedAt`, exactly as ADRs [0004](../../docs/adr/0004-age-bands-are-derived.md) and
[0001](../../docs/adr/0001-no-automatic-unlisting.md) require — not seeded as strings. That is how
the prototype found the index bug noted on the issue: **the filter index cannot store a band.**
ADR 0007's consequence list has the index carrying "age band", but an index written at publish time
that stores the band freezes it, so a dog crossing from `Puppy` into `Young` would re-band only when
someone happens to republish it — reintroducing the invisible scheduled writer ADR 0004 exists to
avoid. The index must carry the two dates and derive both in the browser.
