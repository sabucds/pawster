/**
 * The closed vocabularies a filter axis draws from. Every value here is owned by the
 * platform and never extended by a shelter (`CONTEXT.md`, *Filter Axis*), and the six
 * axes are exactly: species, region, size, age band, sex, and the good-with flags.
 *
 * `AgeBand` is the one axis whose values are not stored anywhere — it lives in
 * `age-band.ts` beside its derivation, because a band is only ever computed from a date
 * ([ADR 0004](../../docs/adr/0004-age-bands-are-derived.md)).
 *
 * These are strings-free on purpose. A band, a size and a sex all need a Spanish word and
 * none of them lives here: the i18n architecture settled in
 * [#48](https://github.com/sabucds/pawster/issues/48) puts UI copy in its own workspace
 * that depends on this package, one way, so a rule can never reach for a label. That
 * workspace does not exist yet and its ADR is still in review, so nothing here may import
 * it — the dependency direction is the part that is settled.
 */

/**
 * Lowercase because these two values are also a `db/` column enum and the filter index's
 * on-the-wire value, and one spelling that survives the whole round trip is worth more
 * than title case in three places. Issue #50's interface sketch writes `"Dog" | "Cat"`;
 * the shipped schema and the prototype both say lowercase, and this follows them.
 */
export type Species = "dog" | "cat";

/**
 * The species vocabulary as data as well as a type, and there is no `Other`.
 *
 * **Two independent reasons the list is data, and both now have callers.**
 *
 * The first is rejection. A closed vocabulary is only closed if something can reject a value
 * at runtime: the types close nothing at the edge of the system, because a publishing form
 * receives strings from a browser and a string TypeScript has been told is a `Species` is
 * still whatever arrived. So each list here comes with a guard, and the guard is what a
 * publishing form, the filter index builder and the digest matcher all narrow through.
 * `CONTEXT.md` makes every axis vocabulary platform-owned "and never extended by a shelter",
 * and the cost of letting one through is not a validation message: a shelter-invented value
 * is one no subscription can match, so it silently costs the shelter the reach it was
 * publishing for. A silent loss is what a runtime guard converts into a refusal.
 *
 * The second is iteration, for the reason {@link GOOD_WITH_AXES} gives: three surfaces read
 * the list rather than naming its members. The signup form renders a checkbox per value
 * (#61), `parseCriteria` validates submitted values against it, and the filter panel (#56)
 * will do both.
 *
 * **The order is the canonical order**, and that is load-bearing. `parseCriteria` sorts a
 * stored criteria set by position in these lists, so the order here is the order a subscriber
 * reads their own saved search back in. Alphabetical order was the alternative and it is
 * wrong for {@link SIZES} and for `AGE_BANDS` — a life stage and a body size both have an
 * order of their own, and sorting their English identifiers destroys it.
 */
export const SPECIES = ["dog", "cat"] as const satisfies readonly Species[];

export function isSpecies(value: string): value is Species {
  return (SPECIES as readonly string[]).includes(value);
}

/**
 * The sub-national area an animal is located in, as an opaque identifier. Regions follow
 * a country's administrative divisions
 * ([ADR 0005](../../docs/adr/0005-region-follows-administrative-divisions.md)), so the
 * vocabulary is reference data that varies by country rather than a union this package can
 * close — seeding a second country must be a lookup, not an edit here.
 *
 * The accepted cost is that this is the one axis with no compile-time vocabulary: a typo in
 * a region id matches no animal instead of failing to build. A branded type would catch it
 * only where a validating constructor exists, and the reference data that would back one is
 * owned by a later ticket, so it would buy casts rather than safety today.
 */
export type Region = string;

/**
 * The adult size a dog is expected to reach. Asked of dogs only, and always about the
 * adult animal, so for a puppy it is a prediction rather than an observation.
 */
export type Size = "Small" | "Medium" | "Large" | "Giant";

/** Smallest first, which is the order a size list is read in and the canonical order. */
export const SIZES = ["Small", "Medium", "Large", "Giant"] as const satisfies readonly Size[];

export function isSize(value: string): value is Size {
  return (SIZES as readonly string[]).includes(value);
}

/**
 * The kilogram ranges each size names, as the adult animal.
 *
 * Here rather than in the form that renders them because they are the *definition* of the
 * vocabulary and not a label for it: `Medium` means 10-25 kg, and a shelter choosing
 * between `Medium` and `Large` for a dog it is guessing about is answering a question about
 * kilograms. Two shelters shown different numbers would be filling in different fields.
 *
 * `null` as an upper bound is `Giant`, which is open-ended — there is no heaviest dog.
 *
 * The words `kg`, `Pequeño` and the sentence telling a shelter this is a prediction are all
 * absent, and deliberately: this package holds no UI copy (see the module comment), so what
 * lives here is the pair of numbers and the naming of them is `web/`'s.
 */
export const SIZE_ADULT_KILOGRAMS: Record<
  Size,
  readonly [minimum: number, maximum: number | null]
> = {
  Small: [0, 10],
  Medium: [10, 25],
  Large: [25, 40],
  Giant: [40, null],
};

/**
 * Whether the size axis applies to this species at all.
 *
 * `CONTEXT.md` asks size "of dogs only", and `Filter Axis` adds that "which axes apply
 * depends on species" — so this is the one place that dependency is written down, and it is
 * a function rather than a comparison at each call site because three callers ask it for
 * three different reasons: a publishing form decides whether to render the control, the
 * publish path refuses a cat that carries a size, and the filter panel decides whether to
 * offer the axis once the species filter is narrowed.
 *
 * A cat's size is not merely unasked, it is *unanswerable* in this vocabulary: the bands are
 * dog weight classes, and a `Small` cat would mean nothing an adopter could filter on.
 */
export function sizeApplies(species: Species): boolean {
  return species === "dog";
}

/** `Unknown` is a recorded absence, not a missing field: it is shown and labelled. */
export type Sex = "Male" | "Female" | "Unknown";

/**
 * `Unknown` is in the vocabulary and so is offered as a criterion, which is the point of
 * it being a first-class value rather than a `null`: a subscriber can ask to be shown the
 * animals whose sex was never recorded, instead of having them silently excluded by a
 * filter they did not know they had set.
 *
 * **Female first**, and the order is #61's rather than either ticket's convenience:
 * `parseCriteria` sorts a stored criteria set by position in this list, so this is the order
 * a subscriber reads their own saved search back in. #55 originally wrote `Male` first, which
 * was arbitrary; nothing in publishing depends on the order, and something in subscribing
 * does.
 */
export const SEXES = ["Female", "Male", "Unknown"] as const satisfies readonly Sex[];

export function isSex(value: string): value is Sex {
  return (SEXES as readonly string[]).includes(value);
}

/**
 * What is known about an animal's tolerance on one axis — "each one yes, no, or not known"
 * (`CONTEXT.md`, *Good-With Flag*). `Unknown` is a first-class value rather than `null`
 * because the platform *displays* it: an adopter is told the answer was never recorded, and
 * a filter shows the animal anyway.
 */
export type GoodWithFlag = "Yes" | "No" | "Unknown";

/**
 * The three answers, and `Unknown` is one of them rather than the absence of one.
 *
 * A shelter must be able to answer "not known" **without losing digest reach**, which is
 * what `CONTEXT.md` means by "a filter on a good-with flag excludes only a known no". The
 * alternative — treating not-known as a non-answer that drops the animal out of matches —
 * teaches shelters that claiming `Yes` is the price of being seen, and the platform would
 * then be collecting confident guesses about whether a dog bites children.
 */
export const GOOD_WITH_FLAGS = [
  "Yes",
  "No",
  "Unknown",
] as const satisfies readonly GoodWithFlag[];

export function isGoodWithFlag(value: string): value is GoodWithFlag {
  return (GOOD_WITH_FLAGS as readonly string[]).includes(value);
}

/**
 * The three good-with axes, as data as well as a type, because the matching rule iterates
 * them. That is the point: the intersection rule that makes a bonded group's tolerance the
 * worst of its members reads this list, so a fourth axis added here is covered by the
 * safety rule the moment it exists instead of being silently exempt from it.
 */
export const GOOD_WITH_AXES = ["children", "dogs", "cats"] as const;

export type GoodWithAxis = (typeof GOOD_WITH_AXES)[number];

/** What is known about one animal on every good-with axis. */
export type GoodWithFlags = Readonly<Record<GoodWithAxis, GoodWithFlag>>;
