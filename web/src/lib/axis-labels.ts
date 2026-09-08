/**
 * The es-VE words for the things a *user* picks from a list: the six criteria vocabularies and
 * the weekdays.
 *
 * The scope is deliberately "vocabulary values", not "all copy". **Three surfaces now render
 * the same six axes** — the digest signup form offers them as checkboxes, the opt-in page reads
 * back what was chosen, and issue #56's listing panel offers them to an adopter — so a second
 * copy of *these* would be two lists that can disagree about what somebody ticked. Prose stays
 * where it is read: a page's sentences are in the page, and the opt-in email's body is in
 * `subscriber/mail.ts`, because a paragraph has one surface and moving it here would buy
 * nothing but distance. `CONTEXT.md`'s *User-facing Spanish* table governs every word in all of
 * those places.
 *
 * ## Why it is here rather than under `subscriber/`
 *
 * It arrived with the digest signup (#61) and its header already named this move: "the form
 * asks for it as free text until #56's filter panel offers the reference data as a list". With
 * the listing shipped, the labels are read by an adopter who has no subscription at all, so a
 * path saying `subscriber/` would be telling the next reader something false about who these
 * words are for. Nothing else changed in the move.
 *
 * ## The shape ADR 0018 asks for, in the package that needs it
 *
 * [ADR 0018](../../../docs/adr/0018-strings-are-typed-phrase-functions.md) settles that UI
 * strings are typed modules in a `strings/` workspace. That workspace does not exist yet —
 * standing it up needs the per-locale routing decision that belongs with the listing (#56,
 * #57), which is the same reason `layouts/Refugios.astro` hard-codes its copy. What is
 * adopted here is the half that is available today and is the half that actually enforces
 * something: **every record below is `satisfies Record<Vocabulary[number], string>`, so a
 * value added to a vocabulary in `domain/` fails this build until it has a word.** An axis
 * the parser accepts and the form cannot label is a checkbox nobody can tick.
 *
 * There is no `agree()` and no gendered pair here, and that is not a shortcut. ADR 0018's
 * gender machinery resolves a word against **one animal's sex**, and a criterion has no
 * animal: `Hembra` is a box a user ticks, not a claim about anybody. The pairs are in
 * `animals/words.ts`, which the listing *card* uses — there there is a sex to agree with.
 */

import {
  CRITERIA_VOCABULARIES,
  type AgeBand,
  type GoodWithAxis,
  type Sex,
  type Size,
  type Species,
  type SubscriptionCriteria,
} from "@pawster/domain";

/**
 * Plural, unlike every other axis, because this is the one whose values name the animal
 * itself: a subscriber is choosing between dogs and cats rather than describing one.
 */
const SPECIES_LABELS = {
  dog: "Perros",
  cat: "Gatos",
} as const satisfies Record<Species, string>;

/** `tamaño adulto` — always about the adult animal, so `Pequeño` is a prediction for a puppy. */
const SIZE_LABELS = {
  Small: "Pequeño",
  Medium: "Mediano",
  Large: "Grande",
  Giant: "Gigante",
} as const satisfies Record<Size, string>;

/**
 * `No se sabe` rather than an omission, because `Unknown` is a recorded absence the platform
 * displays: a subscriber can ask to be shown the animals whose sex was never written down,
 * instead of having them silently excluded by a filter they did not know they had set.
 */
const SEX_LABELS = {
  Female: "Hembra",
  Male: "Macho",
  Unknown: "No se sabe",
} as const satisfies Record<Sex, string>;

/**
 * `Cachorro` and `Gatico` are two values rather than one `Bebé`, which ADR 0018 settles at
 * length: every candidate es-VE word for a shared first band is either wrong or invented, and
 * two chips are each the word a Venezuelan adopter would use unprompted. `Gatico` corrects
 * the prototypes' `Gatito` — es-VE takes `-ico` after a `t` stem.
 */
const AGE_BAND_LABELS = {
  Puppy: "Cachorro",
  Kitten: "Gatico",
  Young: "Joven",
  Adult: "Adulto",
  Senior: "Senior",
} as const satisfies Record<AgeBand, string>;

/**
 * Phrased as the whole criterion rather than as the axis's noun, because membership *is* the
 * criterion: ticking `dogs` asks for an animal that is not an explicit `No` with dogs. A bare
 * `Perros` here would sit under a species filter also offering `Perros` and mean something
 * else entirely.
 */
const GOOD_WITH_LABELS = {
  children: "Convive con niños",
  dogs: "Convive con perros",
  cats: "Convive con gatos",
} as const satisfies Record<GoodWithAxis, string>;

/** One axis: the form field's name, the heading above it, and its values with their words. */
export interface LabelledAxis {
  /** The `FormData` field, which is also the key in a `SubscriptionCriteria`. */
  readonly field: "species" | "sizes" | "sexes" | "ageBands" | "goodWith";
  readonly heading: string;
  readonly values: readonly { readonly value: string; readonly label: string }[];
}

/**
 * One axis, with the vocabulary and its words checked against each other.
 *
 * **Generic over the vocabulary's element type**, which is the line that makes the module
 * comment's claim true rather than decorative. Widened to `readonly string[]` plus
 * `Record<string, string>`, this factory would accept a label record missing an entry and
 * produce `undefined` at runtime — throwing away exactly the guarantee each `satisfies`
 * above establishes, at the one place it has to survive to be worth anything.
 */
const labelledAxis = <Value extends string>(
  field: LabelledAxis["field"],
  heading: string,
  vocabulary: readonly Value[],
  labels: Readonly<Record<Value, string>>,
): LabelledAxis => ({
  field,
  heading,
  // Mapped over the vocabulary rather than over the label record, so the order rendered is
  // the canonical order `parseCriteria()` sorts into — `axes.ts` calls that order load-bearing
  // and a subscriber reading their own choices back should find them in it.
  values: vocabulary.map((value) => ({ value, label: labels[value] })),
});

/**
 * Every closed axis, in the order the form asks about them.
 *
 * The vocabularies come through `CRITERIA_VOCABULARIES` rather than as five separate imports,
 * because that is what it exists for: its own comment promises that "the form that renders the
 * checkboxes and the parser that reads them back have to agree, and the cheapest way to
 * guarantee that is for both to name the same import". Importing `SPECIES` and friends
 * individually here would have left that promise unkept by the only form there is.
 *
 * Species first because it is the one axis that narrows the others — `Cachorro` and `Gatico`
 * only make sense once you know which animal is being asked about — and good-with last
 * because it is a question about the adopter's home rather than about the animal.
 */
export const LABELLED_AXES: readonly LabelledAxis[] = [
  labelledAxis(
    "species",
    "¿Perro o gato?",
    CRITERIA_VOCABULARIES.species,
    SPECIES_LABELS,
  ),
  labelledAxis(
    "ageBands",
    "Etapa",
    CRITERIA_VOCABULARIES.ageBands,
    AGE_BAND_LABELS,
  ),
  labelledAxis(
    "sizes",
    "Tamaño adulto",
    CRITERIA_VOCABULARIES.sizes,
    SIZE_LABELS,
  ),
  labelledAxis("sexes", "Sexo", CRITERIA_VOCABULARIES.sexes, SEX_LABELS),
  labelledAxis(
    "goodWith",
    "Convivencia",
    CRITERIA_VOCABULARIES.goodWith,
    GOOD_WITH_LABELS,
  ),
];

/**
 * The word for one stored criteria value, or the value itself if it has none.
 *
 * The fallback is not defensive padding: a column written before a vocabulary changed can hold
 * a value no longer in it, and `readCriteria()` drops those before they reach here — so what
 * survives to this function is always labelled. Returning the raw value rather than throwing
 * keeps a future third caller from turning a stale row into a 500 on a page a subscriber is
 * reading.
 */
function labelFor(field: string, value: string): string {
  const found = LABELLED_AXES.find((entry) => entry.field === field);
  return found?.values.find((item) => item.value === value)?.label ?? value;
}

/**
 * `dónde está` — the label, never the values.
 *
 * ADR 0005 makes the region vocabulary per-country reference data rather than something this
 * repository closes, so there is no record of words to write here: a region renders as the
 * administrative division's own name, which is already Spanish.
 *
 * **The reference data still does not exist**, so #56's listing does not offer it from a list
 * either — it offers the regions that have animals in them, read out of the filter index. That
 * is the honest set until the lookup lands: a checkbox for a state with nothing in it is a
 * filter that can only ever empty the page. The digest signup form still asks for free text,
 * because it has no index to read.
 */
export const REGION_HEADING = "¿Dónde está?";

/**
 * The weekdays, indexed as `SendDay` — 0 is Sunday, matching `Date.prototype.getUTCDay` and
 * `subscribers.send_day`.
 *
 * Lower-case because they are only ever read inside a sentence ("tu resumen llega los
 * martes"), which is es-VE's own convention for a weekday and not English's.
 *
 * A subscriber is told their day rather than merely assigned one: it is the difference
 * between a promise with a date in it and a vague one, and it is the fact that makes an
 * absent digest noticeable to the person best placed to say so.
 */
export const SEND_DAY_LABELS = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;

/** One axis of a stored criteria, as a heading and the words a subscriber chose under it. */
export interface DescribedAxis {
  readonly heading: string;
  readonly values: readonly string[];
}

/**
 * A stored criteria as headings and words, for reading back to the subscriber who chose it.
 *
 * Only the axes that actually constrain something appear. An absent axis and an empty one
 * mean the same thing to `matches()` — "constrains nothing" — so rendering `Sexo: —` would
 * invent a filter the subscriber did not set, which is precisely the misreading
 * `axes.ts` says `Unknown` exists in the vocabulary to avoid.
 *
 * Iterated in {@link LABELLED_AXES} order rather than in the object's key order, so what a
 * subscriber reads back on the opt-in page is laid out the way the form asked it. Regions come
 * last because they are the one axis with no vocabulary and so the one whose values are the
 * subscriber's own words.
 */
export function describeCriteria(criteria: SubscriptionCriteria): DescribedAxis[] {
  const described: DescribedAxis[] = [];

  for (const axis of LABELLED_AXES) {
    /**
     * `axis.field` is a `keyof SubscriptionCriteria` by construction — `LabelledAxis`'s own
     * field type is that union minus `regions` — so this reads a named property rather than
     * indexing an open record. That is what makes an axis renamed in `domain/` a build error
     * here rather than a heading that silently renders nothing.
     */
    const chosen: readonly string[] | undefined = criteria[axis.field];
    if (chosen === undefined || chosen.length === 0) continue;
    described.push({
      heading: axis.heading,
      values: chosen.map((value) => labelFor(axis.field, value)),
    });
  }

  const { regions } = criteria;
  if (regions !== undefined && regions.length > 0) {
    described.push({ heading: REGION_HEADING, values: [...regions] });
  }

  return described;
}
