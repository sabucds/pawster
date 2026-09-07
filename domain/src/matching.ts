/**
 * Whether an adoption unit matches a subscription's criteria.
 *
 * The signature is the design. `matches` takes the **adoption unit** — a lone animal or a
 * bonded group — and never an animal row, because a bonded group "changes state, is
 * confirmed, and appears in a digest as a single unit" (`CONTEXT.md`) and the two rules
 * that make a group's answer differ from its members' are stated **once, here**, rather
 * than at each of the three call sites that ask the question:
 *
 * - **Intersection on the safety axes.** A group is only as tolerant as its least
 *   tolerant member, because an adopter takes all of them. One dog that is `No` with cats
 *   makes the whole pair `No` with cats.
 * - **Union on the descriptive axes.** A group is everything any of its members is. A
 *   mother-plus-pups litter is both a puppy and an adult, so it reaches subscribers of
 *   either — which is right for a unit adopted whole: an adopter looking for a puppy is
 *   being shown a puppy, and the mother is the condition attached to it.
 *
 * Per-axis union is the stated rule, and it is weaker than the alternative of "some one
 * member satisfies every descriptive criterion". The weaker rule is the one that belongs
 * here: a digest that omits a unit is an adoption that does not happen, while a unit shown
 * to someone whose criteria only half-fit costs them one glance at a card that names every
 * member.
 */

import { type AgeBand, deriveAgeBand } from "./age-band.ts";
import type {
  GoodWithAxis,
  GoodWithFlag,
  GoodWithFlags,
  Region,
  Sex,
  Size,
  Species,
} from "./axes.ts";

/**
 * One animal's filter-axis values: exactly the axes `CONTEXT.md` calls filterable and
 * nothing else.
 *
 * Deliberately **not** named `Animal`. `CONTEXT.md`'s Animal carries "the structured
 * attributes a digest can filter on, plus free-text description and photos", and those
 * last two are display-only and must never reach a rule. This is the filter-axis
 * projection of one — near enough the set ADR 0007 puts in the filter index, which is what
 * lets the browser island hand its parsed index entries straight to `matches`.
 *
 * There is no age band field and there will not be one: the animal carries
 * `estimatedBirthDate` and the band is derived at the moment it is asked for
 * ([ADR 0004](../../docs/adr/0004-age-bands-are-derived.md)). ADR 0007 makes the same
 * point about the index, which carries the two dates and never the bands.
 */
export interface AnimalAxes {
  readonly species: Species;
  readonly region: Region;
  readonly sex: Sex;
  /** `null` for a cat: size is asked of dogs only. */
  readonly size: Size | null;
  readonly estimatedBirthDate: Date;
  readonly goodWith: GoodWithFlags;
}

/**
 * Two or more animals of one shelter that must be adopted together. The tuple type carries
 * the rule that "a group that falls below two members dissolves" — a one-member group is
 * not a thing this package can be handed.
 */
export interface BondedGroup {
  readonly members: readonly [AnimalAxes, AnimalAxes, ...AnimalAxes[]];
}

/** What a digest sends and a listing card shows: one animal, or one bonded group. */
export type AdoptionUnit = AnimalAxes | BondedGroup;

/**
 * One standing set of criteria. Every axis is a **set**, which ADR 0005 required for
 * regions and which costs nothing to give the rest, and every axis is optional: an axis
 * that is absent — or present and empty — constrains nothing. Those two spellings mean the
 * same thing on purpose, so a filter panel can submit what its checkboxes say without a
 * special case for none of them.
 */
export interface SubscriptionCriteria {
  readonly species?: readonly Species[];
  readonly regions?: readonly Region[];
  readonly sizes?: readonly Size[];
  /**
   * Bands, and this is the one place a band is legitimate input. Issue #50 asks that "no
   * band is ever stored or accepted as input; the functions take dates", which is a rule
   * about *animals*: a band stored on an animal stops it ageing, which is what ADR 0004
   * forbids. A band in a subscription is the opposite — it is what the subscriber chose,
   * and what they chose does not age while the animals do. That asymmetry is exactly what
   * makes graduation compose with the digest for free (ADR 0004): a dog crossing into
   * `Young` reaches subscribers of the new band who have never been sent it.
   */
  readonly ageBands?: readonly AgeBand[];
  readonly sexes?: readonly Sex[];
  /**
   * The axes on which the adopter needs a tolerant animal. Membership is the whole
   * criterion: an axis listed here must not be an explicit `No`.
   */
  readonly goodWith?: readonly GoodWithAxis[];
}

/** Every animal in the unit, in order. A lone animal is a unit of one. */
function membersOf(unit: AdoptionUnit): readonly AnimalAxes[] {
  return "members" in unit ? unit.members : [unit];
}

/** An axis absent from the criteria, or present and empty, constrains nothing. */
function constrains<T>(
  values: readonly T[] | undefined,
): values is readonly T[] {
  return values !== undefined && values.length > 0;
}

/**
 * The union rule, once: the unit satisfies a descriptive axis when *some* member carries a
 * value the subscriber asked for. `valuesOf` returns a list rather than a value so that an
 * axis an animal simply does not have — a cat's size — is an empty list and fails the
 * axis, instead of a `null` that has to be special-cased at each axis in turn.
 */
function someMemberHas<T>(
  wanted: readonly T[] | undefined,
  unit: AdoptionUnit,
  valuesOf: (animal: AnimalAxes) => readonly T[],
): boolean {
  if (!constrains(wanted)) return true;
  const required = wanted;
  return membersOf(unit).some((animal) =>
    valuesOf(animal).some((value) => required.includes(value)),
  );
}

type AxisMatcher = (
  criteria: SubscriptionCriteria,
  unit: AdoptionUnit,
  asOf: Date,
) => boolean;

/**
 * One entry per descriptive axis, and the key type is the load-bearing part: it is
 * `keyof SubscriptionCriteria` minus the one safety axis, so **adding an axis to the
 * criteria without adding it here does not compile**. That is the same guarantee
 * `GOOD_WITH_AXES` gives the safety rule, and it is worth having for the same reason — an
 * axis silently missing from this rule is not a cosmetic bug, it is a subscriber receiving
 * animals they explicitly filtered out, in an email they cannot re-filter.
 */
const DESCRIPTIVE_AXES: Readonly<
  Record<Exclude<keyof SubscriptionCriteria, "goodWith">, AxisMatcher>
> = {
  species: (criteria, unit) =>
    someMemberHas(criteria.species, unit, (animal) => [animal.species]),

  regions: (criteria, unit) =>
    someMemberHas(criteria.regions, unit, (animal) => [animal.region]),

  // A `null` size is not "any size": a subscriber filtering on size is asking about dogs,
  // so a cat fails the axis rather than passing it vacuously. Issue #50 does not state
  // this — it follows from `CONTEXT.md`'s "which axes apply depends on species", and the
  // alternative would smuggle cats into a dog subscription.
  sizes: (criteria, unit) =>
    someMemberHas(criteria.sizes, unit, (animal) =>
      animal.size === null ? [] : [animal.size],
    ),

  sexes: (criteria, unit) =>
    someMemberHas(criteria.sexes, unit, (animal) => [animal.sex]),

  // Spelled out rather than routed through `someMemberHas`, so the union a group's card
  // renders and the union its matching uses are the same call.
  ageBands: (criteria, unit, asOf) => {
    const { ageBands } = criteria;
    if (!constrains(ageBands)) return true;
    return ageBandsFor(unit, asOf).some((band) => ageBands.includes(band));
  },
};

/**
 * The unit's own answer on one good-with axis: the worst of its members'. Exported because
 * a bonded group's card and digest row have to *display* this, and a card computing it
 * separately is how the two answers start to disagree.
 */
export function goodWithFor(
  unit: AdoptionUnit,
  axis: GoodWithAxis,
): GoodWithFlag {
  const answers = membersOf(unit).map((animal) => animal.goodWith[axis]);
  if (answers.includes("No")) return "No";
  if (answers.includes("Unknown")) return "Unknown";
  return "Yes";
}

/**
 * The bands the unit is in as of `asOf`: one for an animal, and the distinct union in
 * member order for a group. Exported for the same reason as `goodWithFor` — a litter's
 * card says "cachorro y adulto", and that phrase reads this.
 */
export function ageBandsFor(
  unit: AdoptionUnit,
  asOf: Date,
): readonly AgeBand[] {
  const bands = membersOf(unit).map((animal) =>
    deriveAgeBand(animal.species, animal.estimatedBirthDate, asOf),
  );
  return [...new Set(bands)];
}

/**
 * Whether the unit matches the criteria as of `now`.
 *
 * `now` is an argument rather than a call to `Date.now()` because the age-band axis is
 * derived from a date, and a rule that reads the clock itself is a rule no test can pin.
 * Issue #50's sketch writes `matches(criteria, unit)` with two parameters; its own
 * requirement that "every clock-dependent rule takes `now` as an argument" is why this
 * takes three.
 *
 * This is *matching*, not visibility: `isListed` is the other question, and a caller asks
 * both. Staleness is neither — it is a filter axis nowhere, and changes only how an animal
 * is labelled and ordered (ADR 0001).
 */
export function matches(
  criteria: SubscriptionCriteria,
  unit: AdoptionUnit,
  now: Date,
): boolean {
  for (const satisfiesAxis of Object.values(DESCRIPTIVE_AXES)) {
    if (!satisfiesAxis(criteria, unit, now)) return false;
  }

  // The safety axes, where the unit is only as tolerant as its least tolerant member and a
  // filter excludes only an explicit `No` — `Unknown` is shown and labelled, never hidden.
  for (const axis of criteria.goodWith ?? []) {
    if (goodWithFor(unit, axis) === "No") return false;
  }

  return true;
}
