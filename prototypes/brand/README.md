# Prototype: three brand directions for Pawster

> **Verdict: direction A (Camperito) in Chocolate brown (`#5b3a29`), on a neutral grey page instead of
> cream.** Chosen on
> [Prototype: Pawster's design system and brand manual](https://github.com/sabucds/pawster/issues/106).
> The result is `docs/brand.md`, added in
> [Write the brand manual: direction A in chocolate brown](https://github.com/sabucds/pawster/pull/107).

This is a throwaway prototype, not production code. The real tokens live in
`web/src/styles/base.css`. This file doesn't touch them.

**Open `index.html` by double-clicking.** There is nothing to install and no build step. The page now
shows only direction A. The arrows on the dark bar at the bottom switch between three brown tones,
and so do the left and right arrow keys. The choice is saved in the URL as `?tone=cafe`, `chocolate`
or `caramelo`.

| Tone | Primary | Hover | Tint | Primary on white |
|---|---|---|---|---|
| Café | `#7a4b2a` | `#5c3820` | `#f1e8e0` | 7.3:1 |
| Chocolate | `#5b3a29` | `#432a1d` | `#efe7e2` | 10.1:1 |
| Caramelo | `#8a5a33` | `#6e4626` | `#f5ebe0` | 5.9:1 |

All three share the same neutral greys: page `#fafaf9`, lines `#e7e5e4`, text `#1c1917`, soft text
`#57534e`, white cards. Directions B and C are still in the file but out of the switcher. The table
below describes the original three directions.

The icons (Lucide, Phosphor and two Simple Icons brand marks) and the two font subsets are inlined,
so the page works offline. The dog photos come from dog.ceo and need a connection. Without one you
see grey boxes.

## What each direction shows

Each one is a 360px phone screen in es-VE: the navbar, the filters, two animal cards and a staleness
notice. Below that, inside the same scroll, is its manual: colours with their contrast ratio, type
and its byte cost, buttons, contact buttons, a form field with an error, status labels, icons, and
the weekly digest email as real email HTML (tables and inline styles) in an iframe.

| | A · Camperito | B · Sobrio y confiable | C · Editorial amable |
|---|---|---|---|
| Navigation | Bottom bar with four icons and labels. Top bar holds only the logo. | Sticky top bar: logo, search icon, "Filtros" button with a count. | Logo, search and saved icons, then a sideways chip row. A chip with ▾ opens a bottom sheet. |
| Filters | Search field plus chips | Applied filters as removable tags | Chips that open a bottom sheet with "Limpiar" and "Ver N resultados" |
| Card | Big 4:3 photo, heart on the photo, full-width "Conóceme" | Photo on the left, facts as a list, name as the only link | Square photo with a hand-drawn edge, serif name, facts as soft tags, "Quiero adoptarla" plus share |
| Colour | Orange `#c2410c` | Teal `#03705f`, yellow focus | Coral `#b4432c` and teal `#0f6e75` |
| Shape | Pills, 20px cards | 4px corners, 2px borders | 12px corners, round chips |
| Font | Nunito 800 for logo and titles | System font only | Fraunces 700 for logo, titles and names |
| Icons | Lucide | Lucide | Phosphor |
| Voice | The animal talks: "¡Adóptame!", "Conóceme" | Plain and factual | Warm third person: "Están esperando por ti" |

The CSS weight each direction reports is measured live in the page with gzip. The font sizes are
for the full Latin alphabet. A subset with only the logo's letters is about 1.5 to 2 KB.
