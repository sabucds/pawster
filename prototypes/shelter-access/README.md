# Prototype: shelter sign-in, registration and email change on a phone

> **Verdict: not chosen yet.** The direction gets picked on
> [issue #97](https://github.com/sabucds/pawster/issues/97).

This is a throwaway prototype, not production code. The real pages live in `web/src/pages/refugios/`.

**To open it, double-click `index.html`.** There is nothing to install, no build step and no network.

## What it is

There are five screens with three variants each. They use the same tool and the same base styles
as the shelter-publishing prototype (#95), so both can be compared on one base. The tool shows
each page in an iframe at 320, 360 or 390 px wide. A dashed line marks the bottom of the first
screen at 760 px. A "sin CSS" toggle removes the stylesheet. No page in the prototype runs any
JS, so every form can be checked the way ADR 0007 needs. The left and right arrow keys switch
variant, and up and down switch screen. The URL keeps the state.

| Screen | Variant | What it tests |
|---|---|---|
| **entrar** | A, como hoy | The current page. |
| | B, aviso plegado | The form comes first. The "this page answers the same either way" notice hides under "¿No te llega el código?". |
| | C, dos puertas | "Ya tengo refugio" and "Es mi primera vez" get the same weight. |
| **código** | A, un campo | One field with `inputmode=numeric` and `autocomplete=one-time-code`. |
| | B, seis cajitas | Six one-digit inputs. Without JS, focus doesn't move to the next box, a paste fills only the first box, and autofill fills only the first box. |
| | C, un campo + otro teléfono | A's field, plus a box for when the inbox is on another phone. The code is in the email subject, so the notification already shows it. |
| **avisos** | A, texto como hoy | Invalid code, too many requests, and the daily email limit, all as plain paragraphs. |
| | B, aviso tranquilo + un botón | "Tu refugio está bien" goes on top, followed by one big button for the next step. |
| | C, qué pasó / qué hago | Two headed sections with numbered steps. |
| **registro** | A, solo el formulario | The current page. Verification is mentioned only on the "listo" page. |
| | B, qué pasa después, arriba | Three numbered steps above the form: register, publish right away, and verification within three days. |
| | C, una línea + plegado | A one-line promise, then the form, then "¿Qué pasa después?" folded at the end. |
| **correo** | A, lista antes | The current page. The list of consequences sits before the form. |
| | B, lista + casilla | The list goes in a warning box, plus a required "Entiendo…" checkbox. |
| | C, dos pasos | "Seguir" changes nothing. A confirm page rendered by the server shows the new email in large type, then the red button. |

## Page weight

These are gzipped HTML plus CSS, with no JS and no photos, measured by
`node measure.mjs index.html`. The harness panel shows the same numbers live.

| Screen | A | B | C |
|---|---|---|---|
| entrar | 1.6 KB | 1.6 KB | 1.6 KB |
| código (new / error) | 1.6 / 1.6 | 1.6 / 1.7 | 1.7 / 1.8 |
| avisos (invalid / too many / limit) | 1.4 / 1.4 / 1.4 | 1.4 / 1.5 / 1.5 | 1.5 / 1.5 / 1.5 |
| registro (empty / errors / done) | 1.9 / 2.0 / 1.6 | 2.2 / 2.1 / 1.6 | 2.1 / 2.2 / 1.5 |
| correo (form / error / confirm / done) | 1.8 / 1.9 / n.a. / 1.4 | 1.8 / 1.9 / n.a. / 1.4 | 1.6 / 1.7 / 1.7 / 1.5 |

Weight doesn't decide anything here. The heaviest page is 0.9 KB heavier than the lightest.
