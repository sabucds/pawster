/**
 * The stored form of a {@link SubscriptionCriteria}, and the parser that produces one.
 *
 * `matching.ts` states what a criteria *means*; this states what a criteria *is* once it
 * has left a form and before it reaches a column. Those are two jobs and they are kept
 * apart because only one of them is allowed to be forgiving: `matches()` may assume its
 * input is well-formed, and this is the file that earns it that assumption.
 *
 * ## Why this is in `domain/` and not in `web/`
 *
 * `web/src/lib/auth/policy.ts` records the rule — a pure module with exactly one consumer
 * belongs in the package that consumes it. This one has three, which is the same test
 * `domain/` itself passes:
 *
 * - the signup endpoint (#61) parses a `FormData` into a criteria and writes the column;
 * - the digest matcher (#63) reads that column back and hands the result to `matches()`;
 * - the browser filter panel (#56) submits the same axes from the same closed vocabularies,
 *   and a panel that accepted a value the matcher would ignore is a filter that silently
 *   lies.
 *
 * The third is the one that decides it. A parser living in `web/` would be a parser the
 * browser bundle could not import without pulling a Worker's dependency graph in with it.
 *
 * ## Sets, not scalars
 *
 * Every axis is a set — the ticket's own criterion, and ADR 0005's requirement for regions
 * specifically, since a subscriber in the Caracas commuter belt watches three states at
 * once. Storing a scalar per axis would have made "dogs in Aragua or Carabobo" two of a
 * subscriber's three subscriptions instead of one, which is a third of their allowance
 * spent on the word *or*.
 *
 * The stored form is **canonical**: deduplicated, and ordered by each vocabulary's own
 * order rather than alphabetically. That makes two subscribers who checked the same boxes
 * hold byte-identical columns, and it means the set can be read straight back to the
 * subscriber — on the manage page (#62) and in a digest section header (#64) — in the order
 * a reader expects a life stage or a body size to come in.
 */

import { AGE_BANDS, type AgeBand } from "./age-band.ts";
import {
  GOOD_WITH_AXES,
  type GoodWithAxis,
  type Region,
  SEXES,
  SIZES,
  SPECIES,
  type Sex,
  type Size,
  type Species,
} from "./axes.ts";
import type { SubscriptionCriteria } from "./matching.ts";

/**
 * How long a region identifier may be.
 *
 * Region is the one axis with no compile-time vocabulary (`axes.ts`), so it is the one axis
 * where "is this a value at all" cannot be answered by membership and has to be answered by
 * a bound. Generous against the longest Venezuelan state name and its slug, and short enough
 * that the column cannot be used as free storage by anyone who finds the signup form.
 */
export const MAX_REGION_LENGTH = 60;

/**
 * How many values one axis may carry.
 *
 * Every closed vocabulary is shorter than this, so the bound only ever bites on regions —
 * which is where it is needed, because that axis is open and a submitted list is otherwise
 * unbounded. Twenty-four is above the count of Venezuelan states, so a subscriber asking
 * for the whole country by naming every region can still do it.
 */
export const MAX_CRITERIA_VALUES_PER_AXIS = 24;

/**
 * A region as an identifier: trimmed and lower-cased.
 *
 * **Exported because both sides of the comparison have to do this**, which the regions rule
 * below has always said — "the same normalisation has to happen on the animal's side for the
 * two to ever meet" — and which nothing enforced while only one side existed. Issue #56 is
 * the other side arriving: the filter index carries each animal's region as its shelter typed
 * it, because that string is also what a card displays, and `selectListed` normalises it
 * through this function before `matches` compares. A criteria holding `aragua` and an animal
 * holding `Aragua` are the same region, and without one shared function they are two.
 *
 * Naming it is the whole change. The rule was a closure inside the table and is now a
 * function the table calls, so there is still exactly one definition of it.
 *
 * It cannot check that a region *exists*: ADR 0005 makes the vocabulary per-country reference
 * data, so a typo matches no animal rather than failing to save — `axes.ts` records that as
 * this axis's accepted cost.
 */
export function normaliseRegion(raw: string): Region {
  return raw.trim().toLowerCase();
}

/**
 * One axis's rule: how to read a submitted value, and where a kept value sorts.
 *
 * A table rather than six branches, and the key type is `keyof SubscriptionCriteria`, so
 * **an axis added to the criteria without a rule here does not compile**. That is the same
 * guarantee `matching.ts` gives `DESCRIPTIVE_AXES` and it is worth having twice: an axis
 * the matcher honours but the parser drops is a subscriber whose filter is discarded at the
 * form, and an axis the parser keeps but the matcher ignores is one whose filter is
 * discarded at the digest. Neither is visible from the other end.
 */
type AxisRule = {
  /** The value as it will be stored, or `null` if this is not a value on this axis. */
  readonly read: (raw: string) => string | null;
  /** Position in the canonical order, or `null` to sort lexicographically. */
  readonly order: readonly string[] | null;
};

/** Membership in a closed vocabulary is the whole rule, and the list is also the order. */
function closed(vocabulary: readonly string[]): AxisRule {
  return {
    read: (raw) => (vocabulary.includes(raw) ? raw : null),
    order: vocabulary,
  };
}

const AXES: Readonly<Record<keyof SubscriptionCriteria, AxisRule>> = {
  species: closed(SPECIES),
  sizes: closed(SIZES),
  sexes: closed(SEXES),
  ageBands: closed(AGE_BANDS),
  goodWith: closed(GOOD_WITH_AXES),

  /**
   * The open axis, and the only one that normalises rather than merely admitting.
   *
   * Trimmed and lower-cased because a region arrives as an identifier and `Aragua`,
   * `aragua` and ` aragua ` are one region — and because the same normalisation has to
   * happen on the animal's side for the two to ever meet. Nothing here can check that a
   * region *exists*: ADR 0005 makes the vocabulary per-country reference data, so a typo
   * matches no animal instead of failing to save, which `axes.ts` already records as this
   * axis's accepted cost.
   */
  regions: {
    read: (raw) => {
      const value = normaliseRegion(raw);
      if (value.length === 0 || value.length > MAX_REGION_LENGTH) return null;
      return value;
    },
    order: null,
  },
};

const AXIS_NAMES = Object.keys(AXES) as ReadonlyArray<
  keyof SubscriptionCriteria
>;

/**
 * Read one axis's submitted values into a canonical set, or `undefined` if none survive.
 *
 * `undefined` and not `[]`, because `matching.ts` treats an absent axis and an empty one as
 * the same thing — "constrains nothing" — and storing the empty array would put a second
 * spelling of that in the column for no gain.
 */
function readAxis(
  rule: AxisRule,
  raw: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const kept = new Set<string>();
  for (const candidate of raw) {
    if (typeof candidate !== "string") continue;
    const value = rule.read(candidate);
    if (value !== null) kept.add(value);
  }
  if (kept.size === 0) return undefined;

  const values = [...kept];
  const { order } = rule;
  values.sort(
    order === null
      ? (a, b) => (a < b ? -1 : a > b ? 1 : 0)
      : (a, b) => order.indexOf(a) - order.indexOf(b),
  );

  /**
   * Truncated **after** ordering, so which values survive a submission over the bound is
   * decided by the vocabulary rather than by the order a form happened to serialise its
   * checkboxes in.
   */
  return values.length > MAX_CRITERIA_VALUES_PER_AXIS
    ? values.slice(0, MAX_CRITERIA_VALUES_PER_AXIS)
    : values;
}

/**
 * Read an untrusted object into a criteria, keeping what is a value on its axis and
 * silently dropping the rest.
 *
 * **Silently, and that is the decision.** The alternative — collect a reason per rejected
 * value and report it — is what `web/src/lib/shelter/fields.ts` does for the shelter forms,
 * and it is right there because a shelter is typing prose it can correct. Here every
 * closed-vocabulary value comes from a checkbox the platform itself rendered, so a value
 * outside the vocabulary means a stale form, a crafted post, or a bug — none of which a
 * subscriber can act on, and none of which is worth an error page in place of the
 * subscription they asked for. What *is* worth reporting is a criteria that ends up empty,
 * and that is the caller's judgement rather than this function's: an empty criteria is a
 * legitimate "send me everything" for the digest and a probable mistake at the signup form,
 * and only the caller knows which of those it is.
 */
export function parseCriteria(
  raw: Readonly<Record<string, unknown>>,
): SubscriptionCriteria {
  const criteria: Record<string, readonly string[]> = {};
  for (const axis of AXIS_NAMES) {
    const values = readAxis(AXES[axis], raw[axis]);
    if (values !== undefined) criteria[axis] = values;
  }
  return criteria as SubscriptionCriteria;
}

/**
 * The criteria as it goes into the column.
 *
 * Keys are written in `AXES` order rather than in whatever order they were assigned, so the
 * JSON is canonical as a *string* and not merely as a value. That is what lets two rows be
 * compared with `=` — which the sent-set and the manage page both end up wanting, and which
 * would quietly stop working the first time a caller built its object in a different order.
 *
 * JSON in one column rather than a join table per axis, and the reason is the consumer:
 * `matches()` takes a `SubscriptionCriteria` whole, six axes at once, and every read of this
 * data reads all of it. Six join tables would turn one row into six queries to answer a
 * question nobody asks by axis, and the digest asks it once per subscription per run.
 */
export function writeCriteria(criteria: SubscriptionCriteria): string {
  /**
   * The canonical key order comes from {@link parseCriteria}, which assigns in `AXES` order
   * and so builds its object in it — `JSON.stringify` then emits insertion order for string
   * keys, which is what makes the *string* canonical rather than merely the value.
   *
   * This used to re-order the parsed result into a second object, which was the same loop
   * run twice: whatever `parseCriteria` returns is already in `AXES` order by construction.
   * The guarantee now rests on that one loop, which is where it belongs — a second copy of an
   * ordering rule is a second thing that can drift from the first.
   */
  return JSON.stringify(
    parseCriteria(criteria as Readonly<Record<string, unknown>>),
  );
}

/**
 * A stored column back as a criteria, or an empty criteria if the column is not one.
 *
 * **Forgiving on purpose, and it is the digest that decides it.** This column is read in a
 * `scheduled()` handler working through a shard of subscribers, where a throw is not an
 * error message anyone sees — it is a run that stops partway and a set of subscribers who
 * get nothing, with the only evidence in a log nobody is watching. So a column that is not
 * the JSON it should be degrades to "constrains nothing", which sends a subscriber too much
 * rather than nothing, and the row stays wrong until someone looks.
 *
 * It runs the parser rather than trusting the column, which is the same posture for the same
 * reason: a value that was valid when it was written stops being valid the day a vocabulary
 * changes, and the digest must not hand `matches()` a band that no longer exists.
 */
export function readCriteria(stored: string): SubscriptionCriteria {
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return parseCriteria(raw as Readonly<Record<string, unknown>>);
}

/**
 * The vocabularies a signup form renders and a parser validates against, in one place.
 *
 * Re-exported here rather than left to be imported from three modules, because the form
 * that renders the checkboxes and the parser that reads them back have to agree, and the
 * cheapest way to guarantee that is for both to name the same import.
 */
export const CRITERIA_VOCABULARIES = {
  species: SPECIES,
  sizes: SIZES,
  sexes: SEXES,
  ageBands: AGE_BANDS,
  goodWith: GOOD_WITH_AXES,
} as const satisfies {
  readonly species: readonly Species[];
  readonly sizes: readonly Size[];
  readonly sexes: readonly Sex[];
  readonly ageBands: readonly AgeBand[];
  readonly goodWith: readonly GoodWithAxis[];
};
