/**
 * Age bands are derived at read time from an estimated birth date and never stored
 * ([ADR 0004](../../docs/adr/0004-age-bands-are-derived.md)). Thresholds differ by
 * species and live here, next to the derivation, because changing one silently re-bands
 * every animal at once.
 */

import type { Species } from "./axes.ts";

export type AgeBand = "Puppy" | "Kitten" | "Young" | "Adult" | "Senior";

/**
 * The band vocabulary as data, in **life-stage order**, which is the canonical order a
 * subscription's `ageBands` set is stored and rendered in (`criteria.ts`).
 *
 * `Puppy` and `Kitten` sit together at the front rather than being folded into one value,
 * because they are the same stage under two species' names — a subscription naming both is
 * a subscriber who wants the young of either species, and ADR 0018's band-replacement rule
 * is what turns the pair into one word on screen.
 */
export const AGE_BANDS = [
  "Puppy",
  "Kitten",
  "Young",
  "Adult",
  "Senior",
] as const satisfies readonly AgeBand[];

/**
 * Upper bound, in whole months, of each band below `Senior`. A species' first band is
 * named for the species, which is the only reason `Puppy` and `Kitten` are distinct
 * values rather than one `Juvenile`.
 */
const THRESHOLDS: Record<Species, ReadonlyArray<readonly [AgeBand, number]>> = {
  dog: [
    ["Puppy", 12],
    ["Young", 36],
    ["Adult", 96],
  ],
  cat: [
    ["Kitten", 12],
    ["Young", 36],
    ["Adult", 120],
  ],
};

/** Whole months elapsed, counting a partial month as not yet elapsed. */
export function monthsBetween(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (to.getUTCMonth() - from.getUTCMonth());
  const dayShort = to.getUTCDate() < from.getUTCDate();
  return Math.max(0, dayShort ? months - 1 : months);
}

/**
 * The band an animal is in as of `asOf`. An animal born in the future — a shelter typo —
 * is treated as newborn rather than rejected, because the derivation is a read-time
 * display concern and refusing to render is worse than rendering the first band.
 */
export function deriveAgeBand(
  species: Species,
  estimatedBirthDate: Date,
  asOf: Date,
): AgeBand {
  const age = monthsBetween(estimatedBirthDate, asOf);
  for (const [band, upperBound] of THRESHOLDS[species]) {
    if (age < upperBound) return band;
  }
  return "Senior";
}
