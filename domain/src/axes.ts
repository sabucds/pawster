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
 * The species vocabulary as data as well as a type, for the reason {@link GOOD_WITH_AXES}
 * is: three surfaces now iterate it rather than only naming its members. The signup form
 * renders a checkbox per value (#61), `parseCriteria` validates submitted values against
 * it, and the filter panel (#56) will do both.
 *
 * **The order is the canonical order**, and that is the load-bearing part. `parseCriteria`
 * sorts a stored criteria set by position in these lists, so the order here is the order a
 * subscriber reads their own saved search back in. Alphabetical order was the alternative
 * and it is wrong for {@link SIZES} and for `AGE_BANDS` — a life stage and a body size both
 * have an order of their own, and sorting their English identifiers destroys it.
 */
export const SPECIES = ["dog", "cat"] as const satisfies readonly Species[];

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

/** `Unknown` is a recorded absence, not a missing field: it is shown and labelled. */
export type Sex = "Male" | "Female" | "Unknown";

/**
 * `Unknown` is in the vocabulary and so is offered as a criterion, which is the point of
 * it being a first-class value rather than a `null`: a subscriber can ask to be shown the
 * animals whose sex was never recorded, instead of having them silently excluded by a
 * filter they did not know they had set.
 */
export const SEXES = ["Female", "Male", "Unknown"] as const satisfies readonly Sex[];

/**
 * What is known about an animal's tolerance on one axis — "each one yes, no, or not known"
 * (`CONTEXT.md`, *Good-With Flag*). `Unknown` is a first-class value rather than `null`
 * because the platform *displays* it: an adopter is told the answer was never recorded, and
 * a filter shows the animal anyway.
 */
export type GoodWithFlag = "Yes" | "No" | "Unknown";

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
