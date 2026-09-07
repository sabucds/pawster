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
  GoodWith,
  GoodWithAxis,
  Region,
  Sex,
  Size,
  Species,
  Tri,
} from "./axes.ts";

/**
 * One animal's filter-axis attributes. Exactly the axes `CONTEXT.md` calls filterable and
 * nothing else — free text and photos are display-only and never reach a rule.
 *
 * There is no age band field and there will not be one: the animal carries
 * `estimatedBirthDate` and the band is derived at the moment it is asked for
 * ([ADR 0004](../../docs/adr/0004-age-bands-are-derived.md)). ADR 0007 makes the same
 * point about the filter index, which carries the two dates and never the bands.
 */
export interface Animal {
  readonly species: Species;
  readonly region: Region;
  readonly sex: Sex;
  /** `null` for a cat: size is asked of dogs only. */
  readonly size: Size | null;
  readonly estimatedBirthDate: Date;
  readonly goodWith: GoodWith;
}

/**
 * Two or more animals of one shelter that must be adopted together. The tuple type carries
 * the rule that "a group that falls below two members dissolves" — a one-member group is
 * not a thing this package can be handed.
 */
export interface BondedGroup {
  readonly members: readonly [Animal, Animal, ...Animal[]];
}

/** What a digest sends and a listing card shows: one animal, or one bonded group. */
export type AdoptionUnit = Animal | BondedGroup;

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
   * Bands, not dates. A subscriber chose "puppies", and what they chose does not age —
   * the animals do, which is the asymmetry that makes graduation compose with the digest
   * for free.
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
function membersOf(unit: AdoptionUnit): readonly Animal[] {
  return "members" in unit ? unit.members : [unit];
}

/** An axis absent from the criteria, or present and empty, constrains nothing. */
function constrains<T>(
  values: readonly T[] | undefined,
): values is readonly T[] {
  return values !== undefined && values.length > 0;
}

/**
 * The unit's own answer on one good-with axis: the worst of its members'. Exported because
 * a bonded group's card and digest row have to *display* this, and a card computing it
 * separately is how the two answers start to disagree.
 */
export function goodWithFor(unit: AdoptionUnit, axis: GoodWithAxis): Tri {
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
 * It is also what lets the digest ask the question as of the run's own instant rather than
 * whenever a row happened to be processed.
 *
 * This is *matching*, not visibility: `isListed` is the other question, and a caller asks
 * both. Staleness is neither — it is a filter axis nowhere and changes only how an animal
 * is labelled and ordered (ADR 0001).
 */
export function matches(
  criteria: SubscriptionCriteria,
  unit: AdoptionUnit,
  now: Date,
): boolean {
  const members = membersOf(unit);
  const { species, regions, sizes, sexes, ageBands, goodWith } = criteria;

  // Descriptive axes: the unit is everything any member is.
  const someMember = (predicate: (animal: Animal) => boolean) =>
    members.some(predicate);

  if (
    constrains(species) &&
    !someMember((animal) => species.includes(animal.species))
  ) {
    return false;
  }

  if (
    constrains(regions) &&
    !someMember((animal) => regions.includes(animal.region))
  ) {
    return false;
  }

  if (
    constrains(sizes) &&
    // A `null` size is not "any size": a subscriber filtering on size is asking about
    // dogs, so a cat fails the axis rather than passing it vacuously.
    !someMember((animal) => animal.size !== null && sizes.includes(animal.size))
  ) {
    return false;
  }

  if (
    constrains(sexes) &&
    !someMember((animal) => sexes.includes(animal.sex))
  ) {
    return false;
  }

  if (constrains(ageBands)) {
    const bands = ageBandsFor(unit, now);
    if (!bands.some((band) => ageBands.includes(band))) return false;
  }

  // Safety axes: the unit is only as tolerant as its least tolerant member, and a filter
  // excludes only an explicit `No` — `Unknown` is shown and labelled, never hidden.
  for (const axis of goodWith ?? []) {
    if (goodWithFor(unit, axis) === "No") return false;
  }

  return true;
}
