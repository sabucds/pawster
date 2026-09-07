# UI strings are typed phrase functions, not a key-value table

[ADR 0007](0007-prerender-first-and-filter-in-the-browser.md) bought Astro partly for its built-in
i18n, and that settles routing: `defaultLocale: "es"` with `prefixDefaultLocale: false` puts es-VE at
the root and English under `/en/`, as configuration rather than middleware we own. What it does not
settle is the string layer, and the issue #17 prototype found three things a flat key→string table
cannot express. One of them rendered on screen as **`Gata gatica`**.

**UI strings are TypeScript modules in a `strings/` workspace: one locale module per language, both
implementing a single exported interface, plus a set of pure phrase functions that compose them.
There is no message-format runtime, no JSON message catalogue, and no extraction step.** The unit of
translation is the **rendered phrase**, not the word. `agree()` and the band-replacement rule are
implementation details of `animalHeadline()`; no caller ever joins two translated words together.

That last sentence is the whole decision. The three constraints below are each a case where joining
two correct words produces a wrong phrase, so the fix is structural: **there is exactly one place in
the codebase where a species word and a band word meet**, and it is a function with a table test.

## Gender agreement, and it is not a Spanish-only concession

The first of the three constraints, and the one that shapes the signature.

`Perro adulto` / `Perra adulta`, `Confirmado` / `Confirmada`, `Esterilizado` / `Esterilizada`,
`Pequeño` / `Pequeña` — the prototype's own pairs, masculine first. The prototype's shape is a
gendered pair and a resolver, and it is the minimum that works. This is the only code block in the
ADR series, and it earns its place because the decision *is* the signature: `agree()` returning a
record rather than a string is the whole mechanism, and prose about a return type is a worse
specification than the return type.

```ts
type Sex = "Male" | "Female" | "Unknown"; // to be added to domain/ - see below

type Gendered = { readonly m: string; readonly f: string };

/** A resolved word, carrying whether its gender was known or assumed. */
type Resolved = { readonly word: string; readonly assumed: boolean };

const agree = (word: Gendered, sex: Sex): Resolved =>
  sex === "Female"
    ? { word: word.f, assumed: false }
    : { word: word.m, assumed: sex === "Unknown" };

/** The one place the disclaimer is appended, so no phrase function can forget it. */
const sentence = (t: Strings, parts: readonly Resolved[]): string =>
  parts.map((p) => p.word).join(" · ") +
  (parts.some((p) => p.assumed) ? ` · ${t.sexUnknown}` : "");
```

Named members rather than the prototype's positional `["Perro", "Perra"]`, because a two-element
array of strings type-checks in either order and the wrong order is invisible in review.

**`"Unknown"` resolves to the masculine, and the phrase that resolves it says so — structurally,
not by convention.** Spanish's unmarked form is masculine, so there is no third form to reach for;
but a bare `Perro adulto` for an animal whose sex was never recorded reads as a claim about the
animal, so the resolution has to be disclosed wherever it happens.

The obvious way to write that rule is "every phrase function that can receive `"Unknown"` appends
`sexo no registrado`" — and it is wrong, for exactly the reason this ADR rejects ICU below. A rule
restated at n call sites is a rule one of them will forget, and the failure is invisible: the phrase
still renders, it just quietly asserts a sex nobody recorded. **So `agree()` returns the fact
rather than discarding it**, and `sentence()` is the single combinator that appends the disclaimer,
once, if any part of the phrase was assumed. A phrase function cannot opt out of it without going
around `sentence()` entirely, which is a visible thing to do in review rather than an omission.

That is the whole reason `agree()` returns `Resolved` instead of `string`. A bare `string` throws
away the one bit that the caller then has to remember to re-derive, and "remember to" is what this
ADR is trying to design out.

**Counting the es-VE half of the prototype's table: 15 distinct gendered pairs, of which 6 have
identical members** (`Joven`, `Senior`, `Grande`, `Gigante`, `Sin esterilizar`, `No se sabe`). So a
pair is not evidence of agreement, and a lint that flagged `{m: x, f: x}` would be wrong 40% of the
time. The type can enforce that a pair exists; nothing can enforce that it is right.

**English is not gender-free either, which is why `sex` belongs in the shared signature.** Measured
on the same table: 13 of English's 15 pairs are identical, but two are not — `Neutered` / `Spayed`
and `Not neutered` / `Not spayed`. Had the parameter been an es-only escape hatch, English would
have shipped `Neutered` on every animal. Gender agreement is a property of the *phrase*, and the
phrase function takes the animal's sex in every locale.

**Where sex enters: as a field of the facts the phrase function is given, and nowhere else.** Never a
module-level setting, never inferred from a string, never threaded through a context object. A phrase
function is `(locale, facts) => string`, and the animal's sex is one of the facts. This is the same
posture `domain/` takes with `now`: the thing that varies the answer is an argument.

## The first band's word is a species noun, so it replaces the species word

`Cachorra`, `Gatica`, `Puppy`, `Kitten` all name a species as well as a stage of life. Composing species
and band the way every other band composes double-names the animal, which is how the first prototype
render produced `Gata gatica`. **For the first band only, the band word replaces the species word.**

| | es-VE | English |
|---|---|---|
| **Dog, first band** | `Cachorro` / `Cachorra` | `Puppy` |
| **Cat, first band** | `Gatico` / `Gatica` | `Kitten` |
| Dog, other bands | `Perro joven`, `Perra adulta`, `Perro senior` | `Young dog`, `Adult dog`, `Senior dog` |
| Cat, other bands | `Gato joven`, `Gata adulta`, `Gato senior` | `Young cat`, `Adult cat`, `Senior cat` |

Note the ordering flip in the other rows: Spanish puts the species noun first and the adjective after
it, English the reverse. That is a second reason the headline is a function rather than a template —
the word order is per-locale, and the replacement rule is not.

The prototype's cat pair is `Gatito` / `Gatica`, which mixes two diminutive suffixes. **es-VE takes
`-ico` after a `t` stem** (`gato → gatico`, as `rato → ratico`), so `gatica` implies `gatico`. The
canonical pair is `Gatico` / `Gatica`, and the prototype is wrong here rather than the table above.

## `AgeBand` has no `Baby` member; the first band is `Puppy` or `Kitten`

Issue #50's interface sketch writes `type AgeBand = "Baby" | "Young" | "Adult" | "Senior"`, while
two paragraphs further down the same issue names the bands `Puppy` and `Kitten` when it gives their
thresholds. `Baby` appears nowhere else: `CONTEXT.md` names both species' first bands,
[ADR 0004](0004-age-bands-are-derived.md) and [ADR 0007](0007-prerender-first-and-filter-in-the-browser.md)
each use `Puppy` and neither has ever said `Baby` — though neither mentions `Kitten` either, so
`CONTEXT.md` and `domain/src/age-band.ts` are the only two places that name both. That file, merged
with issue #47, already ships `AgeBand` as `"Puppy" | "Kitten" | "Young" | "Adult" | "Senior"`, and
its own comment gives the same reason this ADR does: the two first bands are distinct values "rather
than one `Juvenile`". **`Baby` is retired**, and the shipped type stands unchanged.

**Two sentences of #50 are superseded, not one.** The sketch is the obvious one. The other is its
claim that "age bands share names across species and not thresholds" — they share neither. Both
species' first bands have their own name, and only `Young`, `Adult` and `Senior` are shared.

The argument is the one this ADR is about. **A single `Baby` member forces the filter panel to label
a band before a species has been chosen, and there is no es-VE word for it.** `Bebé` is not what
anyone calls a young dog; `Cachorro` excludes cats; `Cría` is livestock. Every candidate is either
wrong or invented. With two members the panel simply shows two chips, `Cachorro` and `Gatico`, each
of which is the word a Venezuelan adopter would use unprompted — and a species filter narrows them
without the labels having to change.

The cost is that the type admits `("cat", "Puppy")`, a combination that cannot exist.
`deriveAgeBand()` never produces it, and a subscription filtering on `Puppy` and `Cat` matches
nothing, which is the correct behaviour rather than an error to raise. That is cheaper than a word
we would have to invent.

## Considered options

**A flat key→string table** (`{ "animal.headline.adult": "Perro adulto" }`), with or without
`sprintf`-style interpolation. Rejected by the three constraints above: it can express neither
agreement nor replacement without a key per (species × band × sex) combination — 8 valid
species-band pairs times 3 sexes is **24 keys per locale for one line of a card**, before adult size
joins the same line and multiplies it again.

**ICU MessageFormat at runtime** (`intl-messageformat`). This is the serious rival, because ICU's
`select` genuinely does express gender: `{sex, select, female {Perra} other {Perro}}`. It loses on
two counts.

The first is measured. Bundled with esbuild, minified, carrying **one** gender-select message:
`intl-messageformat` 11.2.14 is **33,192 B minified and 9,631 B gzipped** — the runtime alone,
before a single string of ours. The prototype's complete copy, *both locales*, is **2,444 B
gzipped**. The machinery would cost **3.94× the entire content it exists to carry**, on a page whose
whole filter index is 33.4 KB and whose budget on a metered Venezuelan connection is ~150 KB.
Reproduce with `node scripts/measure-i18n.mjs --icu`.

The second is the one that would have mattered even if it were free. **The band-replacement rule is
not a selection over a variable; it is a rule about how two words combine.** ICU can encode it —
`{band, select, Puppy {Cachorra} other {{species} {band}}}` — but only by restating it inside every
message that composes a species and a band, in every locale, forever. It becomes a thing a
translator can forget, in a file no type checker reads, whose failure mode is `Gata gatica` on a
page nobody reviewing the Spanish is looking at. A rule that must not be forgotten belongs in one
function, not in n message strings.

**A compile-time message framework** (Paraglide and similar). Fairer than ICU on payload: it compiles
messages to tree-shakeable functions and ships almost no runtime. But what it compiles *to* is the
shape this ADR proposes to write directly — a typed function per message — so the question is
whether an inlang project, a message catalogue and a compiler step in the build earn their place
over writing those functions by hand. At two locales and this much copy, they do not: the compiler
buys ergonomics for the easy half of the problem (atoms) and cannot express the hard half
(composition), which would end up in hand-written code beside it anyway. It becomes the second build
system in a repo whose posture is that the Worker should run as rarely as possible and the toolchain
should be as small as possible.

**How much copy that is, measured rather than feared: 121 leaf phrases per locale** — 108 strings
and 13 phrase-building functions, counting each form of a gendered pair separately. That covers the
listing and the animal page only; the shelter publishing area, the admin surfaces and the digest add
more. But it sets the order of magnitude at hundreds, not thousands, which is the range where
hand-written modules stay legible and a catalogue plus compiler is machinery bought for a problem we
do not have. **The trigger to revisit is the arrival of a translator who is not also an engineer**,
since a `.ts` module is a worse handoff format than a catalogue; string count alone is not the
trigger.

**Strings in `domain/`.** Rejected, and the reason is directional rather than aesthetic. `strings/`
depends on `domain/` for `Species`, `Sex` and `AgeBand`; `domain/` must never depend on `strings/`,
because a rule is true regardless of what language states it. As one package that constraint is
unenforceable — nothing stops `isListed()` from reaching for a label. As two, the dependency graph
is the enforcement. It also keeps the digest Worker's bundle free of the filter panel's copy.

Two things about that import list are true today and worth stating rather than discovering in #51:
**`domain/` exports `Species` as `"dog" | "cat"`, lower-case**, while `AgeBand` is `"Puppy"`-cased and
the prototype's copy table is keyed `Dog` / `Cat`. `strings/` takes `domain/`'s casing and the copy
table is re-keyed to match it; the mismatch is the prototype's, and it is not worth a mapping layer.
**And `Sex` does not exist in `domain/` yet** — `domain/src/age-band.ts` defines `Species` and
`AgeBand`, and nothing defines `Sex`. This ADR requires it, as `"Male" | "Female" | "Unknown"`, and
it lands in `domain/` with whichever issue first needs it rather than being invented in `strings/`:
an animal's sex is a fact about the animal, not about how it is worded.

**Serialising strings from the page into the island.** Rejected on the 853-byte measurement in the
consequences below, and worth naming because it is the reflex: prerender per locale, hand the island a `<script type="application/json">`
blob, ship one locale. It cannot carry a phrase function, only atoms, so the composition rules would
have to be duplicated on both sides of the serialisation boundary — which is precisely the seam this
ADR exists to close.

## Consequences

- **`strings/` is a fifth npm workspace**, alongside `web/`, `digest/`, `db/` and `domain/` (ADR 0007,
  issue #47). It is pure, has no dependencies beyond `@pawster/domain`'s types, does no I/O, and is
  importable from a browser bundle — the same constraints `domain/` carries, for the same reason.

- **A locale module is `satisfies Strings`, so a missing key is a build error.** That is the whole
  enforcement mechanism and it is worth being honest about its limit: the type catches *absence*, not
  *wrongness*. An English string pasted into the Spanish module type-checks, and so does a gendered
  pair whose feminine form is the masculine one. Nothing automated catches either; both need a reader
  of the language.

- **Phrase functions return `string`, never markup.** The digest email (issue #64) is a table-based
  HTML document assembled in a Worker with no DOM, and it renders the same meta line the listing card
  does. A function that returned a `<span>` would be unusable there and would make the listing's copy
  untestable outside a browser. Surfaces own their markup; `strings/` owns the words.

- **Three consumers, one import.** The Astro prerender picks its locale module from
  `Astro.currentLocale` and pays nothing at runtime because the work happened at build time; the
  browser island imports the same functions; the digest Worker picks the locale from the subscriber's
  record. The email is the only surface whose locale is a stored per-subscriber fact rather than a
  property of the URL, so the subscriber's locale is captured at opt-in (issue #61) and travels with
  the subscription.

- **The island ships both locales, and this was settled by a number rather than by argument.**
  Measured on the prototype's table, serialised as a bundle would carry it and gzipped at level 9:
  **es alone 1,591 B, en alone 1,470 B, both 2,444 B.** Shipping both costs **853 B** over shipping
  one — against ADR 0007's 33.4 KB filter index and the ~150 KB metered-connection budget, that is
  noise. So no page-to-island serialisation channel is
  built, no per-locale island bundle is configured, and the whole class of "which locale did the
  island get" bugs does not exist. This is the same inversion issue #17 found with the filter index:
  the thing that looks like the payload problem is three orders of magnitude away from the thing that
  is (photos).

- **Every name-interpolating phrase takes an animal or a Bonded Group, never an animal drawn out of
  a group.** `Sobre Mora` is wrong on a page titled *Mora, Nube y Panita*, and the WhatsApp prefill
  that says "les escribo por Mora" asks a shelter for one puppy when the adopter means all three —
  the one failure here that would have cost a real adoption. `CONTEXT.md` already says a Bonded Group
  "change[s] state, [is] confirmed, and appear[s] in a digest as a single unit"; rendering is one
  more place that holds. This is the same rule #50 gives `matches()`, and for the same reason: what
  the reader is looking at is what the function should take.

- **Shelter-authored text is never translated.** Animal names, descriptions, urgency notes and
  shelter display names render as written whatever the page locale is. There is no translation column
  and no per-locale description; a shelter writes once, in whatever language it writes in.

- **Plurals are `n === 1` and `Intl.PluralRules` is not used.** Spanish and English both have exactly
  two plural categories, so a ternary is not a shortcut, it is the complete rule. **The tripwire is a
  third locale with more categories** — Russian, Polish, Arabic — at which point the plural helper
  becomes real and this consequence is what gets revisited. Locale count, not string count, is what
  expires this decision.

- **Tests are table-driven and run in plain Node.** A phrase function is `(locale, facts) => string`,
  so the seam is the same as `domain/`'s: no Worker, no DOM, no clock. `Gata gatica` is a table row,
  as is `Gatico` against `Gatito`, as is the `"Unknown"` masculine fallback carrying
  `sexo no registrado`.

- **`CONTEXT.md`'s _Avoid_ lists govern the English codebase vocabulary only**, and now say so, with
  a bounded `User-facing Spanish` table beside them holding the canonical rendering per concept. The
  scoping rule and the table's own reasoning live there rather than being restated here; what
  matters to this ADR is only that the words a phrase function reaches for have one agreed source.

- **Every number above has one command: `npm run check:i18n`** (or `node scripts/measure-i18n.mjs
  --icu` for the rejected runtime, which needs a network). ADR 0007's figures got
  `measure-bundle-size.mjs` and `measure-ssr-cpu.mjs` for the same reason, and this script sits
  beside them in `package.json`. This was not academic here: a first pass counted leaf phrases with
  a regex over the prototype's source, which counted strings inside comments and counted a string
  nested in a template literal twice, and reported an es/en asymmetry that cannot exist. The two
  locales have identical key structures, and the script now **fails** — non-zero, the way
  `measure-bundle-size.mjs` fails over its limit — if they ever drift apart. The ICU dependency is
  pinned to 11.2.14 in the script, because an unpinned probe would let the three ICU figures above
  go stale silently, which is the failure this consequence exists to prevent.
