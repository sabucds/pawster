# Prototype: what a digest email actually looks like

Throwaway. Answers [issue #15](https://github.com/sabucds/pawster/issues/15). Not production code —
no tests, no error handling, no abstractions. The real templates will live in `digest/` per the
topology in [#9](https://github.com/sabucds/pawster/issues/9); this will not.

**Open `index.html` by double-clicking.** Nothing to install, no build step, no network.

## What it is

Three structurally different digest emails, switchable with the floating bottom bar or the
left/right arrow keys. Each is rendered inside an iframe as real email HTML — tables, inline
styles, its own `<style>` head — so it is isolated from the harness around it.

| Variant | Shape | The end of the question it tests |
|---|---|---|
| **A** — Photo-forward stack | Full-width photo per animal, name, meta, description, its own button | Does 12 animals still scan when every one gets a card? |
| **B** — Scannable rows | 72px thumbnail left, text right, no description, one meta line | One screen, one glance |
| **C** — Hero + text list | One photo per section, everything else a plain linked line | Are the other eleven photos earning their bytes? |

The side panel toggles the things the ticket asks about: 1 / 2 / 3 sections, first-digest vs
ongoing, light vs dark, images loaded vs blocked, 320 / 390 / 640 viewport, and es-VE vs English.
Every control is reflected in the URL, so a specific view is shareable.

## Measured, not guessed

The panel reports two budgets live. HTML size is measured with the photo `src`s rewritten to real
R2 URLs — not the inline placeholder SVGs this file renders — so it is the number Gmail would
count. Image payload assumes pre-generated WebP derivatives at roughly `w × h × 0.17 + 800` bytes.

| Variant | 1 section (12 animals) | 3 sections (24 animals) | Image payload, 3 sections |
|---|---|---|---|
| A | 21.4 KB · 21% of clip | 37.9 KB · 37% of clip | ~828 KB |
| B | 18.7 KB · 18% of clip | 33.0 KB · 32% of clip | ~101 KB |
| C | 10.5 KB · 10% of clip | 17.8 KB · 17% of clip | ~93 KB |

Two findings fall out of that:

- **Gmail clipping is not a real constraint here.** The heaviest possible email — variant A at
  the full 24-animal cap — is 37.9 KB, 37% of the 102 KB threshold. The design would have to
  roughly triple before clipping mattered.
- **The constraint that does bite is the image payload, and it is 8× between variants.** Photo
  count, not HTML, is what a Venezuelan adopter on mobile data pays for.

## Caveats, stated honestly

- Photos are generated placeholder SVGs. They test **size and position in the row**, not whether
  a real photo of a real dog out-pulls the text beside it.
- The dark toggle forces the same rules the `prefers-color-scheme` block applies. Apple Mail and
  iOS honour that block; the Gmail app force-inverts and ignores it. Dark here is the best case,
  not the guaranteed one — it wants confirming on a real device.
- Image byte estimates are a formula, not measurements of real derivatives.

## Vocabulary

Follows `CONTEXT.md` and the model decided in [#11](https://github.com/sabucds/pawster/issues/11):
closed filter-axis vocabularies, derived age bands, dog-only size, good-with flags with an explicit
unknown, bonded groups rendered as one unit, urgency carrying its written reason. Structure follows
[#10](https://github.com/sabucds/pawster/issues/10): one email per subscriber, a section per
subscription (max 3), 12 per section and 24 per email, "and N more matches", manage plus one-click
unsubscribe in the footer, and the line explaining that silence means no new matches.
