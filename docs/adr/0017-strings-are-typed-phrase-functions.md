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

## The three constraints, and what each forces

### Gender agreement, and it is not a Spanish-only concession

`Perra adulta` / `Perro adulto`, `Confirmada` / `Confirmado`, `Esterilizada` / `Sin esterilizar`,
`Pequeña` / `Pequeño`. The prototype's shape is a gendered pair and a resolver, and it is the minimum
that works:

```ts
type Gendered = { readonly m: string; readonly f: string };
const agree = (word: Gendered, sex: Sex): string => (sex === "Female" ? word.f : word.m);
```

Named members rather than the prototype's positional `["Perro", "Perra"]`, because a two-element
array of strings type-checks in either order and the wrong order is invisible in review.

**`Sex.Unknown` resolves to the masculine, and any phrase that resolves it must also say so.**
Spanish's unmarked form is masculine, so there is no third form to reach for; but a bare `Perro
adulto` for an animal whose sex was never recorded reads as a claim about the animal. The rule is
therefore paired: `agree()` falls back to `m`, and every phrase function that can receive
`Sex.Unknown` appends `sexo no registrado`. A `{m, f}` pair makes that fallback silently; writing it
down is the point of this paragraph.

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

### The first band's word is a species noun, so it replaces the species word

`Cachorra`, `Gatica`, `Puppy`, `Kitten` all name a species as well as a life stage. Composing species
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

### `AgeBand` has no `Baby` member; the first band is `Puppy` or `Kitten`

Issue #50's interface sketch writes `type AgeBand = "Baby" | "Young" | "Adult" | "Senior"` while its
prose in the same paragraph names the bands `Puppy` and `Kitten`. `CONTEXT.md`, ADR 0004, ADR 0007
and `domain/src/age-band.ts` all say `Puppy` / `Kitten`. **`Baby` is retired**; the type is

```ts
type AgeBand = "Puppy" | "Kitten" | "Young" | "Adult" | "Senior";
```

and #50's sketch is superseded on this point.

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
`intl-messageformat` is **32.4 KB minified, 9.6 KB gzipped** — the runtime alone, before a single
string of ours. The prototype's complete copy, *both locales*, is **2,665 B gzipped**. The machinery
would cost **3.6× the entire content it exists to carry**, on a page whose whole filter index is
33.4 KB and whose budget on a metered Venezuelan connection is ~150 KB.

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

**How much copy that is, measured rather than feared: 128 leaf phrases in the es-VE half of the
prototype's table, 127 in English.** That covers the listing and the animal page only — the shelter
publishing area, the admin surfaces and the digest add more. But it sets the order of magnitude at
hundreds, not thousands, which is the range where hand-written modules stay legible and a catalogue
plus compiler is machinery bought for a problem we do not have. **The trigger to revisit is the
arrival of a translator who is not also an engineer**, since a `.ts` module is a worse handoff
format than a catalogue; string count alone is not the trigger.

**Strings in `domain/`.** Rejected, and the reason is directional rather than aesthetic. `strings/`
depends on `domain/` for `Species`, `Sex` and `AgeBand`; `domain/` must never depend on `strings/`,
because a rule is true regardless of what language states it. As one package that constraint is
unenforceable — nothing stops `isListed()` from reaching for a label. As two, the dependency graph
is the enforcement. It also keeps the digest Worker's bundle free of the filter panel's copy.

**Serialising strings from the page into the island.** Rejected on the 873-byte measurement in the
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
  Measured on the prototype's table with real gzip: **es alone 1,792 B, en alone 1,524 B, both
  2,665 B.** Shipping both costs **873 B** over shipping one — against ADR 0007's 33.4 KB filter
  index and the ~150 KB metered-connection budget. So no page-to-island serialisation channel is
  built, no per-locale island bundle is configured, and the whole class of "which locale did the
  island get" bugs does not exist. This is the same inversion issue #17 found with the filter index:
  the thing that looks like the payload problem is three orders of magnitude away from the thing that
  is (photos).

- **Every name-interpolating phrase takes the adoption unit, not an animal.** `Sobre Mora` is wrong
  on a page titled *Mora, Nube y Panita*, and the WhatsApp prefill that says "les escribo por Mora"
  asks a shelter for one puppy when the adopter means all three — the one failure here that would
  have cost a real adoption. This is the same rule #50 gives `matches()`, and for the same reason:
  the unit is what the reader is looking at, so it is what the function should take.

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
  as is `Gatico` against `Gatito`, as is the `Sex.Unknown` masculine fallback carrying
  `sexo no registrado`.

- **`CONTEXT.md`'s _Avoid_ lists govern the English codebase vocabulary only**, and now say so. They
  bind identifiers, types, ADRs, tests and English UI copy; they do not bind es-VE UI copy, which is
  why `refugio` is both on Shelter's avoid list and the word every Spanish surface uses. The glossary
  gains a bounded es-VE rendering table covering the terms an adopter or a shelter actually reads —
  bounded because most of the glossary (`Unreferenced Derivative`, `Digest Run`, `Do-Not-Contact`)
  never reaches a user and inventing Spanish for it would be inventing language the project does not
  speak. The table exists for the failure the _Avoid_ lists cannot catch: two surfaces choosing
  `refugio` and `albergue` for one concept.
