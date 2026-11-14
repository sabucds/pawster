# Pawster brand manual

Every page and every email is designed against this file. It comes from
[Prototype: Pawster's design system and brand manual](https://github.com/sabucds/pawster/issues/106).
The maintainer picked direction A ("Camperito") from three, then changed its orange to a dark brown
("Chocolate") and its cream page to neutral greys. The prototype that shows it is on the
`prototype-brand` branch, in `prototypes/brand/index.html` (open it with `?tone=chocolate`). The
references behind the three directions are in `docs/research/brand-references.md` on the
`research/brand-references` branch.

## Personality and voice

Pawster is warm and friendly, and it never looks like a government form. The animals carry the
feeling, so the interface stays quiet around the photos: white cards on a light grey page, one brown
for anything you can press, and rounded shapes.

The voice builds on the *User-facing Spanish* table in `CONTEXT.md` and doesn't replace it.

- On an animal's card and page, the animal may speak in the first person: "Conóceme", "Soy
  tranquila, me encanta pasear". Only there.
- Everywhere else Pawster speaks plainly and uses "tú": "Busca por nombre o zona", "Guardar
  búsqueda". Forms, errors, shelter pages and emails never use the animal's voice.
- Errors say what happened and what to do, in one sentence: "Escribe un correo válido, como
  nombre@correo.com".
- A button names what it does ("Escribir por WhatsApp"). It never says "Clic aquí" or "Enviar".

## Name and logo

The logo is the word `pawster` in lowercase, in Nunito 800, in `--brand`, with the Lucide
`paw-print` icon to its left at 22px. There is no separate mark.

Where the site's CSS doesn't reach:

- **Email header.** The word `pawster` in white, `font: 800 24px Arial, sans-serif`, centred on a
  `#5b3a29` band. Gmail drops web fonts and blocks SVG images, so the header is text, not an image.
  If a picture logo is wanted later, it has to be a PNG.
- **Favicon.** The `paw-print` icon in `#5b3a29` on a transparent background, as `favicon.svg`, with
  a 32px PNG fallback.

## Colour

These tokens replace the `:root` block in `web/src/styles/base.css`. They keep every name that file
already uses (`--ink`, `--ink-soft`, `--line`, `--warn`, `--aged`, `--urgent-bg`, `--urgent-ink`,
`--page`), so the swap breaks nothing that exists today.

```css
:root {
  /* brand */
  --brand: #5b3a29;      /* primary buttons, pressed chips, links, wordmark, focus ring */
  --brand-dark: #432a1d; /* primary button hover, text on --brand-tint */
  --brand-tint: #efe7e2; /* secondary button, current tab, email footer */

  /* neutrals */
  --ink: #1c1917;        /* text */
  --ink-soft: #57534e;   /* secondary text, unselected tabs */
  --line: #e7e5e4;       /* dividers, card and chip outlines (decoration only) */
  --field-line: #8f8a85; /* form field borders, which must be seen */
  --page: #fafaf9;       /* page background */
  --surface: #ffffff;    /* cards, fields, sheets */

  /* states */
  --ok: #166534;         /* verified */
  --ok-bg: #dcfce7;
  --warn: #8a4b00;
  --aged: #8a5a00;       /* stale date (ADR 0001, thresholds from #17) */
  --aged-bg: #fef3c7;    /* staleness notice */
  --aged-ink: #713f12;
  --urgent-bg: #fdeaea;
  --urgent-ink: #9b1c1c; /* urgent, errors, destructive actions */

  /* contact buttons */
  --whatsapp: #157347;
  --instagram: #c13584;
}
```

Run `node scripts/check-brand-contrast.mjs` to check every text and border pair in this block. It
reads the block above, prints each ratio, fails under 4.5:1 for text or 3:1 for field borders and
focus rings, and prints what the block weighs gzipped. Run it with `web/src/styles/base.css` as the
argument once the tokens move there. Two values changed from the prototype because of it: the
WhatsApp green went from `#1f8c4e` (4.3:1 with white) to `#157347`, and field borders got their own
darker grey, because `--line` is 1.3:1 on white.

Rules:

- Brown means "you can press this". Don't use it for decoration or headings.
- Green, amber and red are only for verified, stale and urgent or destructive. They never stand in
  for the brand.
- No dark mode for now. Emails can't have one in Gmail for Android, and one light theme is less to
  test.

## Type

- **Body and interface.** The system font: `16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto,
  sans-serif`. Body text is never under 16px. Secondary text is 14px, labels and tags 13px.
- **Display.** Nunito 800 (SIL Open Font License, $0), for the wordmark, page titles (26px/1.15),
  section titles and the animal's name on cards (22px/1.2). Nothing else uses it.

Nunito is self-hosted as one woff2 subset with `font-display: swap`, so text shows in the system
font straight away and switches when the file arrives. The Latin subset used in the prototype is
9,228 B. It comes from
`https://fonts.googleapis.com/css2?family=Nunito:wght@800&text=<the characters>`. A subset with
only the wordmark's letters is about 2 KB. The font is a separate cached file and not inlined like
`base.css` (ADR 0007), so it costs those bytes once per visitor, not once per page.

## Spacing, radius and elevation

- **Spacing.** Steps of 4px: 4, 8, 12, 16, 24, 32. Page side padding is 16px.
- **Tap targets.** At least 48px tall for buttons, fields and icon buttons; 40px for filter chips.
- **Radius.** Pills (`999px`) for buttons, chips, fields and tags. 20px for cards. 16px for notices.
  Round (`50%`) for icon buttons.
- **Elevation.** One shadow, for cards only:
  `box-shadow: 0 1px 2px #0000000d, 0 6px 16px #1c191714`. Icon buttons that sit on a photo get
  `0 1px 3px #0002` so they read on any picture. Nothing else has a shadow.

## Components

All of these are in the prototype. Its `css-a` block is the reference for exact values.

- **Navigation.** A top bar holds only the logo, centred, 52px tall. A bottom bar with four tabs
  (Inicio, Buscar, Guardados, Avisos), each an icon and a 12px label. The current tab has a
  `--brand-tint` pill behind its icon and `--brand-dark` text.
- **Buttons.** 48px tall pills, 16px bold text, and an icon when the action has one.
  - Primary: `--brand` with white text, `--brand-dark` on hover. One per screen.
  - Secondary: `--brand-tint` with `--brand-dark` text.
  - Ghost: `--brand-dark` text only, for low-priority actions next to a primary.
  - Destructive: white with a 2px `--urgent-ink` border and `--urgent-ink` text.
  - Icon button: a 48px white circle. Use one instead of a text link when the action is a single
    verb with a well-known icon (save, share, close, back).
  - Focus: a 3px `--brand` outline, 2px away from the element.
- **Contact.** WhatsApp and Instagram buttons in their own colours with their logos (Simple Icons),
  full width, stacked. Other contact points are secondary buttons.
- **Form fields.** 48px pill, white, 2px `--field-line` border, bold label above. On error the border
  turns `--urgent-ink` and the message sits under the field with a `triangle-alert` icon, in 14px
  bold `--urgent-ink`. `FormErrors.astro` keeps its job, styled this way.
- **Filter chips.** 40px pills, white with a `--line` border. Pressed: `--brand` with white text. They
  scroll sideways in one row.
- **Animal card.** White, 20px radius, the card shadow. A 4:3 photo on top with a heart icon button
  in its top right corner, and a "Verificado" or "Urgente" badge in its bottom left. Below it: the
  name in Nunito, then zone, age and size with small icons in `--ink-soft`, then when it was
  published (`--aged` and bold when stale), the animal's own sentence in italics if it has one, and
  a full-width primary "Conóceme" button.
- **Notices** (holding screens, staleness). 16px radius, `--aged-bg` with `--aged-ink` text, an icon
  on the left.
- **Tags.** 13px bold pills: verified (`--ok` on `--ok-bg`), urgent (`--urgent-ink` on
  `--urgent-bg`).

## Icons

Lucide (ISC license, $0), drawn as an inline SVG sprite and used with `<use href="#l-name">`, so
there is no icon font and no extra request. 24px by default, 16px inside text lines, always
`aria-hidden` next to a visible label. Brand logos (WhatsApp, Instagram) come from Simple Icons. Add
an icon to the sprite only when a page uses it.

## Photos

Photos are most of what an adopter sees, so they get the most room. On cards they fill the full card
width at 4:3, cropped with `object-fit: cover` and no border. In emails they are 72px squares with
16px corners. Badges and icon buttons on a photo have a white background so they read on any
picture. Every photo's `alt` says the name, the kind and the age, for example "Luna, perra de 2
años".

## Email

Gmail on Android drops web fonts, CSS variables, `<style>` blocks in many cases, SVG and dark mode.
So an email keeps only what survives inline:

- Tables for layout, every colour written as a hex value in a `style` attribute (copy them from the
  token block), Arial instead of Nunito, light background only.
- Header: the text logo on a `#5b3a29` band (see *Name and logo*).
- The animal row from #15: a 72px photo with 16px corners, the name as a bold link in `#432a1d`, the
  facts in `#1c1917`, and the shelter in `#166534` with "✓ Verificado" when verified, otherwise
  `#57534e`.
- One primary button per email: `#5b3a29` with white bold text, a pill (`border-radius: 999px`;
  Outlook shows square corners, which is fine).
- Footer on `#efe7e2`, 13px `#57534e` text, links in `#432a1d`.

This applies to the digest (`digest/src/email.ts`) and to the transactional mails
(`web/src/lib/*/mail.ts`).

## Weight

The token block is 221 B gzipped (`node scripts/check-brand-contrast.mjs` prints it). Run
`node scripts/measure-page-css.mjs` after a build for what each page ships. The prototype's whole
stylesheet for this direction, components included, was about 1.4 KB gzipped. Nunito adds 9,228 B
once per visitor. There is no shared JavaScript; the icon sprite is inline SVG.
