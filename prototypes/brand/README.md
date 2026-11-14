# Prototype: three brand directions for Pawster

> **Verdict: pending.** The maintainer picks one on
> [Prototype: Pawster's design system and brand manual](https://github.com/sabucds/pawster/issues/106).

This is a throwaway prototype, not production code. The real tokens live in
`web/src/styles/base.css`. This file doesn't touch them.

**Open `index.html` by double-clicking.** There is nothing to install and no build step. The arrows
on the dark bar at the bottom switch direction, and so do the left and right arrow keys. The choice
is saved in the URL as `?variant=a`, `b` or `c`.

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
