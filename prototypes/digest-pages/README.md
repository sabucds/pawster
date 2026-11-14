# Prototype: the digest subscriber pages on a phone, in Spanish

> **Verdict: pending.** The human picks on
> [Prototype: the digest subscriber pages on a phone](https://github.com/sabucds/pawster/issues/98).

This is a throwaway prototype, not production code. The real pages live in `web/src/pages/resumen/`
and `web/src/pages/privacidad.astro`. This file doesn't.

**Open `index.html` by double-clicking.** There is nothing to install and no build step.

## What it is

Each subscriber page is rendered in an iframe at 360px, or 320 or 430. The page inside the frame is
plain HTML with its CSS inlined and no script, the same way the real pages ship. Only the control
panel around it uses JavaScript. Every control is saved in the URL, so a link reproduces the view.

- **Sin CSS** strips the `<style>` block, so you can check that every form still makes sense and
  submits without styles.
- **Cuál** switches the data on the manage page (one search, three searches, unsubscribed and
  marked as spam) and switches between the nine outcome pages.
- **Baja y borrar** switches how unsubscribe and delete sit next to each other. It applies to both
  the manage page and the unsubscribe page.

| Page | Variant | What it tests |
|---|---|---|
| Guardar búsqueda | A · Como el listado | The listing's filter panel as it is: small uppercase legend, inline checkboxes. Email first. |
| | B · Chips | Each value is a pill with its checkbox still visible inside. `:has(:checked)` adds the fill. Without `:has` or without CSS, you see a normal checkbox. Email last, next to the button. |
| | C · Plegado | One `<details>` per axis, with the button stuck to the bottom. Shortest page, but without JS a closed axis can't show what you ticked. |
| Mis búsquedas | A · Ficha y tarjetas | Today's order. Everything held comes first, then the searches as cards. |
| | B · Búsquedas primero | The searches and the exits go first. The full list of what's held follows, open, never folded. |
| | C · Agrupado | The eight facts split into "where and when we write to you" and "what has happened". |
| Baja y borrar | Zona aparte | Delete sits in a red-bordered box. One tap each. |
| | Detrás de un desplegable | Delete sits behind a native `<details>`. The first tap opens it and the second tap deletes. Unsubscribe stays one tap. |
| | Lado a lado | Two equal columns, about 160px each at 360px. |
| Avisos y errores | A · Solo texto | Paragraphs, with a link at the end. |
| | B · Paso como botón | The sentence that says what to do comes first, then a full-width button, then the explanation in small text. |
| | C · Etiqueta de estado | Like B, plus a coloured label above the heading. |
| Privacidad | A · Tabla con scroll lateral | The table inside a box that scrolls sideways. |
| | B · Tarjetas | One section per row. It stops being a table. |
| | C · Tabla que se apila | Still a `<table>`. Below 40rem each row stacks with its labels. |

## Measured

All figures come from `index.html`, measured in headless Chromium at 360px. Weight is the full page
HTML with the CSS inlined, compressed with `CompressionStream('gzip')`. The panel recomputes them
live, and "Peso de todas las variantes" lists them all.

| Page | gzip | gzip without CSS | Height at 360px |
|---|---|---|---|
| Guardar A / B / C | 1.7 / 1.7 / 1.8 KB | 1.1 KB | 1221 / 1318 / 872 px |
| Mis búsquedas A / B / C, three searches, delete behind a `<details>` | 1.8 / 1.8 / 1.8 KB | 1.1 KB | 1554 / 1447 / 1586 px |
| Baja | 1.2 KB | 0.6 KB | one screen |
| Avisos A / B / C (revisa-tu-correo) | 1.0 / 1.1 / 1.2 KB | 0.5 KB | one screen |
| Privacidad A / B / C | 2.5 / 2.4 / 2.6 KB | 1.8 KB | 1913 / 2533 / 2749 px |

The shared base plus the button and input styles that every page would add cost 0.5 KB gzip per
page. None of the variants scroll sideways at 320px or 360px.

## Findings that hold whatever is picked

- **The copy promises a feature the manage page doesn't have.** `listo` says the link lets you
  "cambiar tus búsquedas", and `limite` says you can swap one search for another. The manage page
  has no way to remove or change a single search. Only "unsubscribe from everything" and "delete
  everything" exist.
- **`limite` is out of date.** Its comment says the manage page doesn't exist yet, and its copy
  sends people to the end of a digest. People reach `limite` from `activar`, after they've proved
  they own the inbox, so the page could link straight to the manage page.
- **The manage page shows dates as `2026-10-03`.** `dateOnly` uses `toISOString()`. The prototype
  shows "3 de octubre de 2026".
- **The listing's "chips" are plain checkboxes.** Variant B is the first real chip.
- **Without JavaScript, a folded axis can't summarize what's ticked.** That is the cost of variant C
  on the signup form.
- **A table switched to `display:block` loses its table meaning in Safari's screen reader.** Privacy
  C needs `role="row"` and `role="cell"` added back. Privacy B also drops the `<tr>` that the
  retention test looks for (`data-testid="retention-row"`).
