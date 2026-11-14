# Research: brand references for Pawster's design system

Resolves [#106](https://github.com/sabucds/pawster/issues/106). Parent map: [#1](https://github.com/sabucds/pawster/issues/1).

This is the reference-gathering step for the design system and brand manual. It replaces a Mobbin search, because Mobbin is paid and the project has a $0 rule. All pages were fetched on 2026-11-13 with curl (an Android Chrome user agent) or WebFetch. Every claim cites the page it came from. Byte counts come from commands written out in each section, so anyone can run them again. Sites that blocked both tools are listed in [What couldn't be verified](#what-couldnt-be-verified) and are not described.

The maintainer named what they dislike in the current pages: no personality, no icons or UI resources, buttons that are too large or in the wrong place, text links where a button or icon belongs, and a weak navbar and layout. The research leans toward those gaps.

## Summary

- Venezuelan visitors are on Android. StatCounter puts Android at 94.14% and iOS at 5.86% of mobile in October 2026 ([StatCounter](https://gs.statcounter.com/os-market-share/mobile/venezuela)). Gmail on Android is the email client that matters most.
- The warmest adoption sites (El Campito, Miwuki) use a rounded sans font (both use Nunito), one warm accent colour, pill buttons and first-person copy. The UK and US sites (Battersea, Best Friends) are warm in copy but plainer in layout. "Charity guilt" shows up as death counts and "save a life" lines.
- Listing marketplaces put filters in a horizontal chip row above the results, use square or portrait photos with `object-fit: cover`, and keep one primary action in the header. Wallapop has a five-item bottom bar with an icon and a label on each item.
- Icons are cheap. A 12-icon Lucide set inlined in a page is 1,165 bytes gzipped. Lucide is ISC-licensed and has a paw print.
- A custom body font costs 11 to 39 KB. A custom wordmark only costs 1.5 to 2 KB if you subset it to the letters in "Pawster". The system font stays free.
- Gmail on Android ignores `@font-face`, `prefers-color-scheme`, CSS variables and flex. It keeps `border-radius`, `background-image`, `padding` and `max-width`. Emails need table layout, inline colours, a PNG logo and a light-only design.
- Three directions are worth prototyping: "Camperito" (warm orange, rounded wordmark, bottom bar), "Plain and trustworthy" (GOV.UK-style teal, system font, sticky top bar) and "Friendly editorial" (coral and teal, serif wordmark, first-person filters). See [Directions worth prototyping](#directions-worth-prototyping).

## Adoption and animal-welfare sites

### El Campito Refugio (Argentina)

Source: [elcampitorefugio.org](https://elcampitorefugio.org/) and [/adoptar/](https://elcampitorefugio.org/adoptar/). WebFetch got a 503, but curl worked.

- Colours: orange `#ff9600` with tints `#ffefde` and `#fca430`. Fonts: Nunito (400 to 700) and Open Sans from Google Fonts. Radius 10px, with 200px pills on buttons.
- They give their dogs a group name, "Camperitos". Copy is in voseo and speaks to the visitor: "Adoptá a tu primer Camperito", "Conocé a los perritos que buscan una familia y un nuevo hogar". Buttons say "¡Quiero Adoptar!", "¡Doná ahora!" and "¡Adoptame!". The last one is written in the dog's voice.
- The adoption page shows a numbered five-step process.
- Feel: warm, with some guilt ("es salvar una vida"). HTML is 117 KB, or 20 KB gzipped.
- Takeaway for Pawster: a shared nickname for the animals and buttons in the animal's voice give a lot of personality for zero bytes. Note that `#ff9600` on white is only 2.18:1, so it fails AA for text. Pawster would need a darker orange.

### Miwuki (Spain)

Source: [miwuki.com](https://miwuki.com/). I couldn't find the listing page, so this covers the home page only.

- Self-hosted Nunito. Colours: teal `#4db8c0`, coral `#ff583d` and `#ff8c69`, yellow `#f8c960`, ink `#1f2937`. Radius 16px and 12px, plus 999px pills.
- Copy: "Un ecosistema para el bienestar animal", with two entry buttons, "Quiero adoptar" and "Soy protectora". The page has an illustration file named "ilustracion-miwuki".
- Feel: warm and practical, no guilt. HTML is 115 KB, or 25 KB gzipped.
- Takeaway: two big role buttons on the landing page ("I want to adopt" and "I'm a shelter") work as the main navigation. Teal and coral both fail AA as text on white (2.35:1 and 3.13:1), so they only work as fills behind dark text or as decoration.

### Battersea (UK)

Source: [battersea.org.uk/rehome/dogs](https://www.battersea.org.uk/rehome/dogs) and the [dog rehoming gallery](https://www.battersea.org.uk/dogs/dog-rehoming-gallery).

- Colours: purple `#3301c2` and navy `#021d49`. Franklin Gothic URW (a paid font) and Font Awesome. Radius is mostly 0 or 4px. Photos use `object-fit: cover`.
- Card, from top to bottom: an optional "Reserved" tag, a 325x325 square photo, the name as a heading, the breed, then "Age 1 Year, 1 Month". Sex and location are not on the card.
- Filters live in a "Pet Filter" panel with "Clear all" and "Apply" buttons. The filter labels are in the dog's voice: "Where you'll find me", "I can live with" (Cats, Dogs, Babies, Children, Teenagers), "I'm comfortable alone for", "My age" (Puppy, Young, Adult). A results count reads "92 matches".
- Header: logo, a search icon button and a "Donate" button.
- Copy: "Every rescue at Battersea has a unique character, quirks and lots of love to give" and "We understand that waiting can be hard".
- Feel: warm and reassuring, no guilt. The site loads a 1.29 MB stylesheet, so it is not a weight model.
- Takeaway: the first-person filter labels are the strongest voice idea in this research. In es-VE they could read "Me llevo bien con", "Mi edad", "Dónde estoy".

### Best Friends Animal Society (US)

Source: [bestfriends.org/adopt](https://bestfriends.org/adopt).

- Colours: orange `#ec720b` and blue `#003eb8`. Open Sans. Square 1:1 photos with `object-fit: cover`.
- Card: photo, an "Animal Previews" label, the name and an "Adopt [Name]" link. Above the cards is a species filter row (All Animals, Dogs, Cats and so on).
- Copy: "Your local animal shelter is full of one-of-a-kind characters". Mostly warm, with one guilt line: "396,000 cats and dogs were killed in 2025".
- Takeaway: a single species chip row above the results is enough as a first filter.

### Fundación Affinity (Spain)

Source: [fundacion-affinity.org](https://www.fundacion-affinity.org/). It redirected to the English page.

- Colours: red-orange `#dd4a26` and `#f24822`, ink `#1c1717`, tint `#fff4f1`. TWK Lausanne (paid). Built with Mantine.
- HTML is 1.85 MB, or 156 KB gzipped.
- Feel: warm in colour, clinical in tone. The site leads with research and reports.
- Takeaway: shows how a red-orange plus a very pale warm tint reads as "animal welfare" without photos. Not a layout model because of its weight.

## Listing marketplaces

These are the sites people in Latin America and Spain already use to browse listings on a phone.

### Wallapop (Spain)

Source: [es.wallapop.com](https://es.wallapop.com/).

- Colours: teal `#038673` and `#3dd2ba`, ink `#29363d`, surface `#f0f3f5`. Custom fonts (WallieFit, WallieChunky). Radius 16px on cards and 8px elsewhere. Photos use `object-fit: cover`.
- The page has a `BottomNavigationBar` with `position: fixed; bottom: 0`. It holds five items, each an icon with a label under it: "Inicio", "Favoritos", "Súbelo", "Buzón", "Tú".
- HTML is 240 KB, or 38 KB gzipped.
- Takeaway: a bottom bar with icon plus label is the norm for a Spanish-language listing app. Each item has a visible word, so nobody has to guess what an icon means.

### Vinted (Spain)

Source: [vinted.es catalog search for "collar perro"](https://www.vinted.es/catalog?search_text=collar%20perro).

- Card, from top to bottom: a 310x430 portrait photo, the brand, a "Destacado" badge, a line like "M · Muy bueno", the price, and the price with fees ("incl.").
- Filter chip row above the results: Categoría, Talla, Marca, Estado, Color, Precio, Material. A separate "Ordenar por" control handles sorting.
- The header has one filled button, "Vender ahora". Font V-Inter. Radius 6px, with fully round pills (3996px) on chips.
- The home page HTML is 1.7 MB, or 326 KB gzipped. Treat it as a pattern reference, not a weight model.
- Takeaway: the chip row scrolls sideways and each chip opens one filter. Short card metadata on one line, joined by a middle dot, keeps cards short.

### Craigslist Caracas

Source: [craigslist.org/area/caracas](https://www.craigslist.org/area/caracas).

- Text only, no images, system sans-serif. HTML is 53 KB, or 9 KB gzipped.
- The header holds four text links: "post", "account", "favorites", "hidden".
- Takeaway: the lightest possible end. It shows what the maintainer dislikes, links everywhere and no personality. It is still useful as the floor for page weight.

### Mercado Libre Venezuela

Source: [listado.mercadolibre.com.ve/perros](https://listado.mercadolibre.com.ve/perros). The site served a "suspicious traffic" page to curl and a 403 to WebFetch, so I could not see a listing card. The CSS on the blocked page shows the brand tokens only: blue `#3483fa`, yellow `#fff159`, green `#00a650`, and Proxima Nova with a Roboto fallback. I don't describe its layout.

## Navbar, header and layout patterns

Pulled from the sites above:

| Site | Header | Bottom bar | Filter placement |
|---|---|---|---|
| Wallapop | Logo and search | Yes, fixed, 5 icon-plus-label items | Search first |
| Vinted | Logo, search, one "Vender ahora" button | Not seen in the fetched HTML | Horizontal chip row above results, plus "Ordenar por" |
| Battersea | Logo, search icon button, "Donate" button | No | "Pet Filter" panel with "Clear all" and "Apply", plus a results count |
| Best Friends | Logo and menu | No | Species chip row above cards |
| Craigslist | Four text links | No | None on the area page |

Patterns that repeat:

- One filled button in the header at most. Everything else is an icon button or a plain logo.
- Filters sit above the results, either as a chip row or as a single "Filtros" button that opens a panel. The panel ends with "Clear all" and "Apply" and shows a results count.
- A fixed bottom bar only appears on the site with several top-level sections (Wallapop). Pawster's adopter side has few sections (browse, a shelter page, the digest). A bottom bar with three items is the most it would need, and a sticky top bar may be enough.

## Buttons, targets and icon buttons at 360px

### Size rules

- WCAG 2.2 success criterion 2.5.8 asks for targets of at least 24x24 CSS px. Links inside a sentence are exempt. A smaller target passes if a 24px circle centred on it doesn't overlap another target ([W3C, Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).
- Android's own accessibility guide asks for "touch target size, of at least 48dpx48dp" ([Android developers](https://developer.android.com/guide/topics/ui/accessibility/apps)). On the web that maps to a 48px tall tap area. The visible button can be smaller if padding makes up the rest.

### Placement and wording

From the GOV.UK button guidance ([design-system.service.gov.uk/components/button](https://design-system.service.gov.uk/components/button/)):

- "Align the primary action button to the left edge of your form."
- Use secondary buttons sparingly.
- "Only use warning buttons for actions with serious destructive consequences", and "Do not only rely on the red colour". The button text has to say what happens.
- "Write button text in sentence case."
- A start button is a link styled as a button, because it goes to a page rather than submitting a form. Button groups line up links next to buttons.

### Size and shape on the references

- El Campito and Miwuki use pill buttons (200px and 999px radius). Wallapop uses 16px on cards and 8px on controls. Battersea and GOV.UK stay at 0 to 4px.
- Pico CSS form controls use `.75rem` vertical and `1rem` horizontal padding with a 16px font ([picocss.com](https://picocss.com/)). That gives a control about 48px tall, which meets the Android 48dp target without looking oversized.

### When the references use an icon button instead of a text link

- Search is an icon button in the header (Battersea, Wallapop).
- Filters are chips or a single "Filtros" button with a sliders icon (Vinted, Battersea).
- Bottom bar items are an icon with a label (Wallapop).
- Contact actions on Pawster (WhatsApp, Instagram, email) fit the same rule. Each should be a button with the brand icon and a short label, not a bare link.
- Text links stay for sentences and for secondary navigation. Craigslist shows what happens when everything is a link.

Suggested rule for Pawster: a primary action is a filled button, full width at 360px, about 48px tall. A secondary action is an outlined button. A repeated action that people learn quickly (search, filter, favourite, share) is a 48x48 icon button with an `aria-label`. A text link only appears inside a sentence.

## Design systems and their token scales

### GOV.UK Design System

Source: [design-system.service.gov.uk](https://design-system.service.gov.uk/), the [colour page](https://design-system.service.gov.uk/styles/colour/) and the [spacing page](https://design-system.service.gov.uk/styles/spacing/).

- Colours: text `#0b0c0c`, secondary text `#484949`, link `#1a65a6`, link hover `#0f385c`, visited `#54319f`, focus `#ffdd00`, error `#ca3535`, success `#0f7a52`, border `#cecece`, input border `#0b0c0c`, brand `#1d70b8`. It requires WCAG 2.2 AA contrast (1.4.3).
- Spacing in px, small screens / large screens: 0: 0, 1: 5, 2: 10, 3: 15, 4: 15/20, 5: 15/25, 6: 20/30, 7: 25/40, 8: 30/50, 9: 40/60. The breakpoint is 640px.
- The yellow focus ring with black text (12.55:1 measured below) is the most copied idea from this system.
- govuk-frontend CSS is 132 KB raw, 15.8 KB gzipped. Pawster would copy the tokens, not the CSS.

### USWDS

Source: [designsystem.digital.gov/design-tokens/spacing-units](https://designsystem.digital.gov/design-tokens/spacing-units/).

- Spacing on an 8px base: 05 = 4px, 1 = 8px, 105 = 12px, 2 = 16px, 205 = 20px, 3 = 24px, 4 = 32px, 5 = 40px, 6 = 48px. It also names widths: card 160px, mobile 320px, tablet 640px.
- The CSS is 527 KB raw, 60 KB gzipped. Too heavy to ship, useful for its scale.

### Pico CSS v2

Source: [picocss.com](https://picocss.com/).

- `--pico-border-radius: .25rem`, `--pico-spacing: 1rem`, form padding `.75rem` by `1rem`, primary `#0172ad`, system font stack. The Pico site itself uses Figtree.
- `pico.min.css` is 11.6 KB gzipped. The classless version is 10.3 KB gzipped.

### Open Props v1

Source: [open-props.style](https://open-props.style).

- Sizes: size-1 .25rem, 2 .5rem, 3 1rem, 4 1.25rem, 5 1.5rem, 6 1.75rem, 7 2rem, 8 3rem, 9 4rem.
- Radius: radius-1 2px, 2 5px, 3 1rem, 4 2rem, radius-round 1e5px. It also has `radius-drawn-*` values, uneven corner radii that look hand-drawn. Those are a free personality touch for a badge or a photo frame.
- The full file is 7.7 KB gzipped. The sizes file alone is 454 B, borders 385 B and shadows 494 B gzipped.

### What this means for Pawster

Pawster's base CSS is about 300 bytes gzipped today. None of these systems should be shipped whole. A 4px or 8px base spacing scale (USWDS or Open Props), a GOV.UK-style focus ring and a two- or three-step radius scale fit in a few hundred bytes of custom properties.

## Icons

### Sets and licences

All files came from jsDelivr. Versions: lucide-static 1.72.0 (ISC), @tabler/icons 3.51.0 (MIT), @phosphor-icons/core 2.1.1 (MIT), heroicons 2.2.0 (MIT), @material-symbols/svg-400 0.49.0 (Apache-2.0), simple-icons 16.37.0 (CC0-1.0). The licence is the one in each package's `package.json` on jsDelivr. All of them allow use without payment. ISC, MIT and Apache-2.0 ask you to keep the licence notice with the source. CC0 asks nothing.

### Bytes per icon

Raw bytes / bytes after `gzip -9`, for one SVG file on its own:

| Icon | Lucide | Tabler outline | Phosphor regular | Heroicons 24 outline | Material Symbols rounded |
|---|---|---|---|---|---|
| Paw | 499 / 313 (`paw-print`) | 1,554 / 754 (`paw`) | 816 / 403 (`paw-print`) | none | 804 / 422 (`pets`) |
| Heart | 449 / 307 | 420 / 265 | 489 / 317 | 376 / 281 | 645 / 419 (`favorite`) |
| Search | 352 / 251 | 409 / 252 | 243 / 195 (`magnifying-glass`) | 296 / 226 | 476 / 326 |
| Filters | 511 / 282 (`sliders-horizontal`) | 649 / 299 (`adjustments-horizontal`) | 360 / 230 | 429 / 262 | 1,416 / 365 (`tune`) |
| Map pin | 437 / 303 | 475 / 291 | 459 / 298 | 396 / 252 | 539 / 347 (`location_on`) |
| Mail | 391 / 269 | 450 / 267 | 282 / 226 (`envelope-simple`) | 473 / 279 (`envelope`) | 360 / 268 |
| Dog | 785 / 471 | 781 / 385 | 794 / 445 | none | not measured |
| Cat | 611 / 380 | 616 / 337 | 777 / 433 | none | not measured |

Brand icons from Simple Icons: WhatsApp 1,216 / 666, Instagram 2,101 / 1,023. The brand colours are WhatsApp `#25D366` ([Meta brand resources, WhatsApp](https://about.meta.com/brand/resources/whatsapp/whatsapp-brand)) and Instagram `#FF0069` ([Meta brand resources, Instagram](https://about.meta.com/brand/resources/instagram)). WhatsApp green on white is 1.98:1, so a WhatsApp button needs dark text on the green (8.52:1 with `#1a1d22`) or white text on a darker green.

Single-file gzip overstates the cost, because a page compresses icons together and they repeat the same attributes. A 12-icon set (paw, heart, search, filters, map pin, mail, chat, Instagram, close, back arrow, dog, cat) joined into one file:

| Set | Raw | gzip -9 |
|---|---|---|
| Lucide | 4,729 | 1,165 |
| Tabler outline | 6,819 | 1,526 |
| Phosphor regular | 5,493 | 1,830 |

Command, run from an empty folder (zsh):

```sh
J=https://cdn.jsdelivr.net/npm
run(){ name=$1; pat=$2; shift 2; : > $name.txt
  for i in "$@"; do curl -sL -o one.svg ${pat/ICON/$i}
    grep -v '@license' one.svg | tr -s ' \n' ' ' >> $name.txt; echo >> $name.txt; done
  echo "$name raw=$(wc -c <$name.txt) gz=$(gzip -9c $name.txt | wc -c)"; }
run lucide "$J/lucide-static/icons/ICON.svg" paw-print heart search sliders-horizontal map-pin mail message-circle instagram x chevron-left dog cat
```

The Tabler and Phosphor lines use the same function with their own paths and names: `$J/@tabler/icons/icons/outline/ICON.svg` and `$J/@phosphor-icons/core/assets/regular/ICON.svg`.

### How to ship only the icons you use

- Copy each SVG you need into the repo as a small component or partial, and inline it in the prerendered HTML. No icon font, no runtime package, no request.
- If one page repeats an icon many times (a heart on every card), put it once in a hidden `<svg>` as a `<symbol id="i-heart">` and reference it with `<svg><use href="#i-heart"/></svg>`. Each use is then about 40 bytes.
- Lucide icons are 24x24, `stroke="currentColor"`, `stroke-width="2"` with round caps and joins. The paw print is three circles and one path ([lucide-static paw-print.svg](https://cdn.jsdelivr.net/npm/lucide-static@1.72.0/icons/paw-print.svg)). Because the stroke is `currentColor`, the icon takes the text colour, so no extra CSS is needed for colour or dark mode.
- Keep the ISC or MIT notice in a `LICENSES` note or a comment in the icon folder.

### Which set fits

- Lucide is the smallest as a set, has a paw print, dog and cat, and its rounded strokes match a rounded wordmark.
- Phosphor has six weights (thin to fill and duotone), so one icon can switch to a filled version for an "active" state in a bottom bar.
- Tabler's `paw` is the heaviest single icon at 754 B gzipped.
- Heroicons has no animal icons.
- Material Symbols looks most at home on Android, but its files are the largest on average.

## Personality resources

- **Open Doodles** by Pablo Stanley is CC0 and comes as SVG and PNG ([opendoodles.com/about](https://www.opendoodles.com/about)). The about page does not mention animals, so it may only help with people in empty states.
- **OpenMoji** is CC BY-SA 4.0, so it needs attribution and share-alike ([OpenMoji README](https://github.com/hfg-gmuend/openmoji)). It has cat and dog emoji in a flat, outlined style.
- **The Lucide paw print** is the cheapest mascot motif: 313 bytes gzipped, takes the text colour, and works as a favicon, a bullet, an empty-state image or a loading mark.
- **Open Props `radius-drawn-*`** gives badges or photo frames a hand-drawn edge for a few bytes of CSS ([open-props.style](https://open-props.style)).
- **Voice.** El Campito's group nickname ("Camperitos") and its buttons in the dog's voice ("¡Adoptame!"), and Battersea's first-person filter labels, add personality with words instead of bytes.
- **Empty states.** None of the fetched listing pages showed an empty result, so I have no reference for one. A paw print icon plus one line in the animal's voice ("Por ahora no hay nadie aquí. Vuelve pronto.") would cost almost nothing.

## Email

Data comes from caniemail's API ([caniemail.com/api/data.json](https://www.caniemail.com/api/data.json), `last_update` 2026-09-16). Each feature also has a page at `https://www.caniemail.com/features/<slug>/`. Gmail's own CSS page backs up the Gmail rows ([developers.google.com/workspace/gmail/design/css](https://developers.google.com/workspace/gmail/design/css)).

### Gmail on Android

| Feature | Support | Note from caniemail |
|---|---|---|
| `@font-face` web fonts | No | |
| `border-radius` | Yes | |
| `background-image` | Yes | `linear-gradient` inline in `background-image` is buggy |
| `padding`, `width`, `max-width` | Yes | |
| `margin` | Partial | No negative values |
| `font-weight` | Yes | |
| `box-shadow` | Partial | Non-Google accounts only |
| flex and grid | Partial | "Not supported with non Google accounts" |
| `object-fit` | Partial | Non-Google accounts only |
| `aspect-ratio` | No | |
| CSS variables | No | |
| `prefers-color-scheme` | No | "transformed into @media ( _filtered_a )" or "@media none" |
| `color-scheme` property | No | |
| `<meta name="color-scheme">` | Partial (since 2026-09) | "Only the value `light only` is supported" |
| `<style>` | Partial | Not inside `<body>`, not with non-Google accounts, and the style tag is capped at 16 KB |
| `<link>` stylesheets | No | |
| SVG images | Partial | "rendered but rasterized in PNG" |
| WebP | Partial | Converted to JPG, no animation |
| `<picture>` | No | Replaced by `<u>` |
| `rgba()` | Partial | The space-separated syntax strips the whole style |

Gmail's own page says `<style>` blocks work with class, element and ID selectors, and media queries work for `all` and `screen` with `min-width`, `max-width`, `orientation` and resolution. It also says "Gmail might ignore unsupported CSS properties."

### Other Android and iOS clients

- Samsung Email (Android) supports `@font-face`, `prefers-color-scheme`, `color-scheme`, CSS variables and SVG.
- Outlook for Android supports flex, `object-fit` and `box-shadow`, but not `@font-face`.
- Apple Mail on iOS supports almost every feature checked.
- Outlook on Windows doesn't support `border-radius`.

### What this means for the four email parts

- **Branded header.** Send the logo as a PNG `<img>` with width, height and alt text. SVG becomes a PNG in Gmail anyway, and web fonts don't load, so a text wordmark would fall back to the system font. A solid background colour on a table cell works everywhere. Rounded corners work in Gmail but not in Outlook on Windows.
- **Listing row with a photo.** Use a two-cell table: a fixed-size JPEG (for example 96x96, cropped on the server, since `object-fit` and `aspect-ratio` are unreliable) and a cell with the name, one metadata line and a button. Make the button a padded link with a solid background and `border-radius`, inline.
- **Fonts.** Use the system font stack. Gmail desktop can show Roboto and Google Sans only "because they're embedded with the webmail's own styles", per caniemail's note on `@font-face`. On Android the system font is Roboto in most cases, so the email will look like Roboto whatever we declare.
- **Dark mode.** Gmail on Android doesn't run `prefers-color-scheme` and may recolour the email itself. Design for light, set `<meta name="color-scheme" content="light only">`, avoid pure-white logos on transparent backgrounds, and give the logo PNG its own solid background.
- Keep all colours as inline hex values. Variables and `rgba()` with spaces break.

## Web font byte cost

### How I measured

Each Latin woff2 file from Fontsource on jsDelivr, downloaded with curl, recording the transfer size:

```sh
curl -sL -o /dev/null -w '%{size_download}\n' \
  https://cdn.jsdelivr.net/npm/@fontsource/figtree/files/figtree-latin-400-normal.woff2
```

The Google Fonts numbers come from requesting `https://fonts.googleapis.com/css2?family=<Font>:wght@400;700&display=swap` with an Android Chrome user agent, then downloading the Latin block's woff2 URL the same way. woff2 is already compressed, so gzip on the server doesn't make it smaller. The Latin subset (U+0000 to 00FF) covers ñ, á, é, í, ó, ú, ü, ¿ and ¡, which is all es-VE needs.

### Results (bytes)

Fontsource, static Latin files:

| Font | 400 | 700 | Both |
|---|---|---|---|
| Inter | 23,664 | 24,356 | 48,020 |
| Nunito | 16,316 | 16,228 | 32,544 |
| Figtree | 11,384 | 11,376 | 22,760 |
| Atkinson Hyperlegible | 17,208 | 17,524 | 34,732 |
| Fraunces | 17,968 | 18,212 | 36,180 |
| Bricolage Grotesque | 22,364 | 22,384 | 44,748 |

Fontsource variable Latin files (one file covers every weight): Figtree 20,156, Nunito 39,128, Inter 48,256.

Google Fonts, Latin block, Android Chrome user agent:

- Figtree 400 and 700 are served as one variable file of 20,184 bytes.
- Nunito 400 and 700 are served as one variable file of 39,152 bytes.
- Atkinson Hyperlegible is static: 11,208 (400) and 11,364 (700).
- Fraunces 700 alone: 18,216.

Wordmark only, using Google Fonts' `&text=Pawster` parameter so the file holds just those letters:

| Font and weight | Bytes |
|---|---|
| Nunito 800 | 1,488 |
| Bricolage Grotesque 700 | 1,572 |
| Fraunces 700 | 1,992 |

The system font stack costs 0 bytes. On Android it is Roboto.

### What this means

A body font is a large share of the page. One Figtree weight (11 KB) is about 37 times today's 300-byte base CSS. A wordmark subset costs about 2 KB and gives the logo its own shape. The cheapest way to get personality from type is a subset wordmark (or an SVG of it) with the system font for body text. ADR 0007's small-payload goal points the same way.

## Screenshots worth saving

Open these on a phone, or in a 360px-wide browser window, and save a screenshot of each:

| What to capture | URL |
|---|---|
| El Campito adoption page, buttons and the five steps | https://elcampitorefugio.org/adoptar/ |
| Miwuki landing, the two role buttons and the illustration | https://miwuki.com/ |
| Battersea dog list, the card and the "Pet Filter" panel open | https://www.battersea.org.uk/rehome/dogs |
| Best Friends adopt page, the species chip row and square cards | https://bestfriends.org/adopt |
| Wallapop home, the fixed bottom bar | https://es.wallapop.com/ |
| Vinted search results, the chip row and card | https://www.vinted.es/catalog?search_text=collar%20perro |
| GOV.UK button page, primary, secondary and warning buttons | https://design-system.service.gov.uk/components/button/ |
| Open Props borders, the hand-drawn radii | https://open-props.style |
| Lucide paw print and animal icons | https://lucide.dev/icons/paw-print |

## Colour contrast checks

Every pair in the directions below was measured with the WCAG relative-luminance formula ([WCAG 2.2, contrast ratio definition](https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio)). AA needs 4.5:1 for normal text and 3:1 for large text and for UI parts like borders and icons.

| Foreground | Background | Ratio |
|---|---|---|
| `#c2410c` | `#ffffff` | 5.18 |
| `#c2410c` | `#ffefde` | 4.60 |
| `#9a3412` | `#ffffff` | 7.31 |
| `#1f2937` | `#ffefde` | 13.04 |
| `#03705f` | `#ffffff` | 6.02 |
| `#03705f` | `#e6f4f1` | 5.33 |
| `#1a1d22` | `#ffdd00` | 12.55 |
| `#b4432c` | `#ffffff` | 5.56 |
| `#0f6e75` | `#ffffff` | 5.99 |
| `#1f2937` | `#fff4ef` | 13.59 |
| `#1a1d22` | `#25d366` | 8.52 |
| `#ffffff` | `#0b7a3e` | 5.43 |
| `#5b6472` | `#ffffff` | 5.98 |
| `#9b1c1c` | `#fdeaea` | 7.04 |
| `#8a4b00` | `#ffffff` | 6.80 |
| `#ff9600` | `#ffffff` | 2.18 (fails) |
| `#4db8c0` | `#ffffff` | 2.35 (fails) |
| `#ff583d` | `#ffffff` | 3.13 (fails for text) |
| `#25d366` | `#ffffff` | 1.98 (fails) |

The current tokens `--ink-soft #5b6472`, `--warn #8a4b00` and `--urgent-ink #9b1c1c` on `--urgent-bg #fdeaea` all pass AA and can stay in every direction. Staleness bands from ADR 0001 and the "verified" mark still need their own colours, and the prototype should check those with the same formula.

## What couldn't be verified

- **Petfinder** returned 403. Dropped.
- **adoptame.mx** had no DNS record. Dropped.
- **protectorabcn.es** returned 403. Dropped.
- **ANAA** (Spain): the listing URL returned 404. Only the home page's Lato font and `#e2a707` gold were visible. Not used.
- **Mercado Libre Venezuela**: blocked by a traffic check. Brand tokens only, no card anatomy.
- **OLX Brasil, Encuentra24, Yapo**: all returned 403. Dropped.
- **Material 3 navigation bar guidance**: the page needs JavaScript and returned no content. Dropped. Android's 48dp target comes from the Android accessibility guide instead.
- **unDraw** licence page: 403 behind a Cloudflare check. I can't confirm its licence, so it is left out of the personality resources.
- **Miwuki listing page**: not found. Only the home page is described.
- **Vinted bottom bar**: not seen in the fetched HTML. The page may add it with JavaScript. I don't claim either way.
- I could not render pages, so nothing here describes how a page looks at 360px. Descriptions come from HTML and CSS. The screenshots above are what would confirm it.

## Directions worth prototyping

Each direction keeps the system font for body text and the current warning and urgent tokens. They differ in accent colour, wordmark, shape, icon set and navigation.

### A. "Camperito": warm and rounded

Personality: a friendly neighbourhood shelter that talks in the animal's voice.

- **References.** El Campito (orange, Nunito, pills, "¡Adoptame!" voice), Miwuki (Nunito, role buttons), Wallapop (bottom bar).
- **Palette.** Primary `#c2410c` (5.18:1 on white, white text on it is also 5.18:1). Pressed or hover `#9a3412` (7.31:1). Tint `#ffefde` for cards and chips (primary text on it is 4.60:1). Ink `#1f2937` (13.04:1 on the tint).
- **Type.** Wordmark in Nunito 800, subset to "Pawster", 1,488 bytes. Body in the system font, 0 bytes. Adding Nunito for headings would cost 39,152 bytes as a variable file, which is too much.
- **Shape.** Pill buttons and chips (999px), 16px radius on cards.
- **Navbar.** A fixed bottom bar with three items, each a Lucide icon with a label under it: "Inicio" (paw print), "Buscar" (search), "Avisos" (mail, for the digest). A slim top bar holds only the wordmark.
- **Buttons.** Primary is a filled orange pill, full width at 360px, 48px tall. Contact buttons ("Escribir por WhatsApp", "Ver Instagram") are pills with the brand icon on the left. Favourite and share are 48x48 icon buttons.
- **Icons.** Lucide, about 1.2 KB gzipped for 12 icons.
- **Personality.** The paw print as favicon, bullet and empty-state mark. Button text in the animal's voice, matching CONTEXT.md's gendered forms: "¡Adóptame!", "Conóceme".
- **Approximate added cost.** About 1.5 KB wordmark plus about 1.2 KB icons.

### B. "Plain and trustworthy": clear and official

Personality: a calm public service that shelters and adopters can trust.

- **References.** GOV.UK (focus ring, button rules, left-aligned primary action, small radius), Pico (48px controls, system font), Craigslist (the weight floor), Battersea (search icon in the header, filter panel with a results count).
- **Palette.** Primary teal `#03705f` (6.02:1 on white, white on it 6.02:1). Tint `#e6f4f1` (primary text on it 5.33:1). Focus ring `#ffdd00` with `#1a1d22` text (12.55:1). Ink stays `#1a1d22`.
- **Type.** System font for everything, including the wordmark, which is drawn as an inline SVG with the paw print. 0 bytes of font.
- **Shape.** 4px radius on buttons, inputs and cards. 2px borders on inputs.
- **Navbar.** A sticky top bar: wordmark on the left, a search icon button and a "Filtros" button (sliders icon plus the word) on the right. No bottom bar.
- **Buttons.** Primary is filled teal, left-aligned at full width on 360px, 48px tall, sentence case. Destructive actions say what they do and use `#9b1c1c` with a text label, following GOV.UK's "Do not only rely on the red colour". Contact actions are outlined buttons with the brand icon.
- **Icons.** Heroicons outline (smallest single files) or Lucide if a paw print is needed. Heroicons has no paw or animal icons.
- **Personality.** Lowest of the three. It comes from copy and photos only. This is the safe fallback if the others feel too playful for shelters.
- **Approximate added cost.** About 1 KB of icons. No font.

### C. "Friendly editorial": warm with a voice

Personality: a local magazine that introduces each animal like a person.

- **References.** Battersea (first-person filter labels, reassuring copy), Miwuki (coral and teal pairing), Fundación Affinity (red-orange with a very pale warm tint), Vinted (horizontal chip row, one-line card metadata), Open Props (hand-drawn radii).
- **Palette.** Primary coral `#b4432c` (5.56:1 on white, white on it 5.56:1). Secondary teal `#0f6e75` (5.99:1) for links and the "verified" mark. Tint `#fff4ef` behind cards (ink on it 13.59:1). Ink `#1f2937`.
- **Type.** Wordmark and animal names in Fraunces 700. As a "Pawster" subset it is 1,992 bytes. For every animal name it needs the full Latin file at 18,216 bytes. Body in the system font. Figtree as a body font is an option at 20,184 bytes for a variable file, but it isn't needed.
- **Shape.** 12px radius on cards and buttons, fully round chips, and an Open Props hand-drawn radius on photo frames.
- **Navbar.** A sticky top bar with the wordmark and a search icon button. Under it, a horizontal chip row that scrolls sideways: "Perros", "Gatos", "Mi edad", "Me llevo bien con", "Dónde estoy". Tapping a chip opens a bottom sheet with "Limpiar" and "Ver N resultados".
- **Buttons.** Primary is a filled coral button, full width at 360px, 48px tall, 12px radius. Secondary is an outlined teal button. Icon buttons are 48x48 for favourite, share and close.
- **Icons.** Phosphor regular, with the filled weight for active states. About 1.8 KB gzipped for 12 icons.
- **Personality.** Filter labels and empty states in the animal's voice. Optional OpenMoji animals with credit (CC BY-SA 4.0).
- **Approximate added cost.** About 2 KB for the wordmark, or 18 KB if Fraunces is used for names, plus about 1.8 KB for icons.
