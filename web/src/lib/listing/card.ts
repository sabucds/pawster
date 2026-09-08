/**
 * One listing card: what it says, and the markup that says it.
 *
 * Two pure functions and no DOM. That is a testability decision and it is the only one
 * available: the cards are built in the browser from the filter index, and `web/`'s suite runs
 * in a `workerd` isolate with no document in it (`docs/testing-seams.md`). So the card's
 * *judgements* — which lines appear, in which order, with which emphasis — live in
 * {@link cardModel}, where every acceptance criterion #17 argued for can be asserted directly,
 * and {@link renderCard} is left with nothing but string interpolation.
 *
 * The alternative was a second Vitest project with a DOM library, which would have added a
 * dependency to test a function whose whole content is the judgements above.
 *
 * ## The field set is committed, and the layout is what enforces it
 *
 * #17's card is A — Mosaico 2×, fixed height — and its one real defect is that a two-up grid
 * makes every row as tall as its tallest card over data that is intrinsically variable-height.
 * The fix is a **fixed two-line reservation for the convivencia slot**, which means committing
 * to a fixed field set: photo, name, urgency chip, one meta line, one provenance line, and the
 * convivencia slot. Nothing here is optional-and-sometimes-taller, which is why
 * {@link CardModel}'s convivencia is three named slots rather than a list of chips.
 */

import type { ListedAnimal } from "@pawster/domain";
import {
  GOOD_WITH_AXES,
  deriveAgeBand,
  deriveStalenessBand,
  daysBetween,
} from "@pawster/domain";
import type { GoodWithAxis } from "@pawster/domain";
import {
  cardMetaLine,
  goodWithPhrase,
  goodWithPositivesPhrase,
  goodWithUnknownLine,
  provenanceLine,
} from "../animals/words.ts";

/**
 * The convivencia slot: **three visual weights, not one tri-state chip row.**
 *
 * The three are not one visual class and treating them as one is exactly what produces the
 * wall of chips #17 measured. A known `No` is a safety fact and the filter excludes only an
 * explicit `No`, so someone browsing unfiltered has to see it; a known `Yes` is useful rather
 * than urgent and merges; and the unknowns collapse into one named line so that
 * non-information is not the heaviest thing on the card.
 */
export interface Convivencia {
  /** One legible warning per known `No` — `No convive con gatos`. */
  readonly warnings: readonly string[];
  /** Every known `Yes`, merged — `Con niños y gatos`. `null` when there are none. */
  readonly positives: string | null;
  /** Every unknown, collapsed into one line. `null` when nothing is unknown. */
  readonly unknown: string | null;
}

export interface CardPhoto {
  readonly src: string;
  /**
   * The **box**, not the bytes, and #56 is explicit that these attributes "are what reserves
   * the box before the bytes arrive". They are the card's own fixed 4:5 photo frame, so the
   * height the browser reserves is a function of the layout rather than of a photograph that
   * has not arrived — which is what makes the grid unable to shift as images load, and what
   * lets a fixed-height card hold aspect-preserving derivatives at all (`cardThumbnail` is
   * `scale-down` at 400px on the long edge, so its shape varies per photo).
   */
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

export interface CardModel {
  readonly id: string;
  readonly href: string;
  readonly name: string;
  /** `Perra adulta · Mediana`, with an assumed gender disclosed once for the whole card. */
  readonly meta: string;
  /** The uniform line, on every card, in the same position. */
  readonly provenance: string;
  /**
   * Whether the provenance line's colour shifts, which happens **past 30 days** and nowhere
   * else on the card. Derived from `domain/`'s staleness bands rather than from a `30` written
   * here, so the threshold that re-bands every animal at once lives in one place.
   */
  readonly provenanceAged: boolean;
  readonly convivencia: Convivencia;
  /**
   * A chip beside the name, and **not a sort key**. The cap is three per shelter and the
   * listing is cross-shelter, so the platform can cap urgency per shelter but not per screen —
   * a banner degrades to noise the moment several shelters use their allowance, and
   * urgency-first ordering would let a handful of them own the first screen (#17, ADR 0001).
   */
  readonly urgent: boolean;
  readonly photo: CardPhoto;
}

/** The card's photo frame: 4:5, which is #17's variant A at a real 360px viewport. */
export const CARD_PHOTO_WIDTH = 344;
export const CARD_PHOTO_HEIGHT = 430;

/** The axes whose answer is `flag`, in `GOOD_WITH_AXES` order so two cards agree. */
function axesAnswering(
  animal: ListedAnimal,
  flag: "Yes" | "No" | "Unknown",
): readonly GoodWithAxis[] {
  return GOOD_WITH_AXES.filter((axis) => animal.goodWith[axis] === flag);
}

/**
 * What one card says, decided once.
 *
 * `now` is an argument, as it is everywhere the platform derives something from a date: both
 * the age band in the meta line and the staleness in the provenance line are computed here
 * from the index's two dates, which is the whole reason the index carries dates and no bands
 * (ADR 0004). The same index bytes therefore describe an animal correctly a year later.
 *
 * `mediaBase` is the bucket's public base URL, baked into the page at build time — the reason
 * a card can be built with no Worker involved at all.
 */
export function cardModel(
  animal: ListedAnimal,
  now: Date,
  mediaBase: string,
): CardModel {
  const band = deriveAgeBand(animal.species, animal.estimatedBirthDate, now);

  return {
    id: animal.id,
    href: `/animales/${animal.id}`,
    name: animal.name,
    meta: cardMetaLine(animal, band),
    provenance: provenanceLine(animal, daysBetween(animal.lastConfirmedAt, now)),
    provenanceAged: deriveStalenessBand(animal.lastConfirmedAt, now) !== "Fresh",
    convivencia: {
      warnings: axesAnswering(animal, "No").map((axis) =>
        goodWithPhrase(axis, "No"),
      ),
      positives: goodWithPositivesPhrase(axesAnswering(animal, "Yes")),
      unknown: goodWithUnknownLine(axesAnswering(animal, "Unknown")),
    },
    urgent: animal.urgent,
    photo: {
      src: `${mediaBase}/${animal.thumbnailKey}`,
      width: CARD_PHOTO_WIDTH,
      height: CARD_PHOTO_HEIGHT,
      /**
       * The animal's name and nothing more. A photograph of a dog captioned with a description
       * the shelter wrote for adopters is not what a screen-reader user needs from a grid of
       * twelve; the name is the card's identity and the rest of the card is text already.
       */
      alt: animal.name,
    },
  };
}

/**
 * Interpolated into HTML, so every value goes through here first.
 *
 * The names, regions and urgency notes in the index are shelter-authored text, and the index
 * arrives over the network — so this is untrusted input being written into a document. It is
 * escaped rather than assigned through `textContent` because the card is built as a string:
 * one `innerHTML` for the whole grid is one reflow, where twelve cards' worth of
 * `createElement` is a few hundred DOM operations on the cheapest phone the platform is built
 * for.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One card as markup.
 *
 * **`width` and `height` attributes, and `height: auto` in the stylesheet.** Both, and the
 * pairing is the bug #17 caught: `max-width: 100%` without `height: auto` makes an `<img>`
 * carrying those attributes ignore its box's `aspect-ratio`, and every card renders about 40%
 * too tall. The attributes cannot be dropped instead — they are what reserves the box before
 * the bytes arrive, which is what gives a blocked photo and a loaded one the same document
 * height.
 *
 * `loading="lazy"` and `decoding="async"` because photo payload is the listing's real
 * constraint — 8.6× between card shapes for the same twelve animals — and a two-up grid of
 * 344×430 photos is more than one screen's worth on any handset.
 *
 * The convivencia slot renders its three weights in a fixed order and inside a container the
 * stylesheet reserves two lines for, so a card with two warnings and a card with none are the
 * same height.
 */
export function renderCard(card: CardModel): string {
  const warnings = card.convivencia.warnings
    .map(
      (warning) =>
        `<li class="convivencia-no">${escape(warning)}</li>`,
    )
    .join("");
  const positives = card.convivencia.positives
    ? `<li class="convivencia-si">${escape(card.convivencia.positives)}</li>`
    : "";
  const unknown = card.convivencia.unknown
    ? `<li class="convivencia-sin">${escape(card.convivencia.unknown)}</li>`
    : "";

  return `<li class="card" data-testid="card" data-animal-id="${escape(card.id)}">
  <a class="card-link" href="${escape(card.href)}">
    <img
      class="card-photo"
      src="${escape(card.photo.src)}"
      width="${card.photo.width}"
      height="${card.photo.height}"
      alt="${escape(card.photo.alt)}"
      loading="lazy"
      decoding="async"
    />
    <h2 class="card-name">${escape(card.name)}${
      card.urgent
        ? ' <span class="chip-urgent" data-testid="urgent-chip">Urgente</span>'
        : ""
    }</h2>
    <p class="card-meta" data-testid="card-meta">${escape(card.meta)}</p>
    <p class="card-provenance${
      card.provenanceAged ? " is-aged" : ""
    }" data-testid="card-provenance">${escape(card.provenance)}</p>
    <ul class="card-convivencia" data-testid="card-convivencia">${warnings}${positives}${unknown}</ul>
  </a>
</li>`;
}
