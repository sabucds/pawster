/**
 * The closed vocabularies a filter axis draws from. Every value here is owned by the
 * platform and never extended by a shelter (`CONTEXT.md`, *Filter Axis*), and the six
 * axes are exactly: species, region, size, age band, sex, and the good-with flags.
 *
 * `AgeBand` is the one axis whose values are not stored anywhere — it lives in
 * `age-band.ts` beside its derivation, because a band is only ever computed from a date
 * ([ADR 0004](../../docs/adr/0004-age-bands-are-derived.md)).
 *
 * These are strings-free on purpose. A band, a size and a sex all need a Spanish word,
 * and none of them lives here: [ADR 0017](../../docs/adr/0017-strings-are-typed-phrase-functions.md)
 * puts UI copy in a separate `strings/` workspace that depends on this package, one way,
 * so a rule can never reach for a label.
 */

/**
 * Lowercase because these two values are also a `db/` column enum and the filter index's
 * on-the-wire value, and one spelling that survives the whole round trip is worth more
 * than title case in three places.
 */
export type Species = "dog" | "cat";

/**
 * The sub-national area an animal is located in, as an opaque identifier. Regions follow
 * a country's administrative divisions ([ADR 0005](../../docs/adr/0005-region-follows-administrative-divisions.md)),
 * so the vocabulary is reference data that varies by country rather than a union this
 * package can close — seeding a second country must be a lookup, not an edit here.
 */
export type Region = string;

/**
 * The adult size a dog is expected to reach. Asked of dogs only, and always about the
 * adult animal, so for a puppy it is a prediction rather than an observation.
 */
export type Size = "Small" | "Medium" | "Large" | "Giant";

/** `Unknown` is a recorded absence, not a missing field: it is shown and labelled. */
export type Sex = "Male" | "Female" | "Unknown";

/**
 * What is known about one tolerance: yes, no, or not known. `Unknown` is a first-class
 * value rather than `null` because the platform *displays* it — an adopter is told the
 * answer was never recorded, and a filter shows the animal anyway.
 */
export type Tri = "Yes" | "No" | "Unknown";

/**
 * The three good-with axes, as data rather than only as a type, because `matches` iterates
 * them. That is the point: the intersection rule that makes a bonded group's tolerance the
 * worst of its members reads this list, so a fourth axis added here is covered by the
 * safety rule the moment it exists instead of being silently exempt from it.
 */
export const GOOD_WITH_AXES = ["children", "dogs", "cats"] as const;

export type GoodWithAxis = (typeof GOOD_WITH_AXES)[number];

/** What is known about an animal on every good-with axis. */
export type GoodWith = Readonly<Record<GoodWithAxis, Tri>>;
