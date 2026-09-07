/**
 * Staleness is how long ago an animal was last confirmed, derived at read time and never
 * stored ([ADR 0001](../../docs/adr/0001-no-automatic-unlisting.md)). It changes how an
 * animal is labelled and ordered and **never whether it is listed** — which is why it
 * appears nowhere in `isListed` and nowhere in `SubscriptionCriteria`.
 *
 * The thresholds live here for the same reason the age-band ones do: they re-band every
 * animal at once, and they reuse clocks the design already has — 30 days is where the
 * confirmation nudge fires, 90 is where a shelter is called dormant.
 */

export type StalenessBand = "Fresh" | "Ageing" | "Stale";

/** Inclusive upper bound, in whole days, of each band below `Stale`. */
const THRESHOLDS: ReadonlyArray<readonly [StalenessBand, number]> = [
  ["Fresh", 30],
  ["Ageing", 90],
];

/**
 * Whole days elapsed, counting a partial day as not yet elapsed.
 *
 * Plain millisecond arithmetic, which is right here and would not be for the age bands:
 * both timestamps are instants (`timestamp_ms` in `db/`), and "how long ago" is a
 * duration rather than a calendar question. There is no local time zone to be wrong
 * about, so no DST discontinuity to fall into.
 */
export function daysBetween(from: Date, to: Date): number {
  const elapsed = to.getTime() - from.getTime();
  return Math.max(0, Math.floor(elapsed / 86_400_000));
}

/**
 * The band an animal's last confirmation is in as of `asOf`. A confirmation dated in the
 * future — clock skew, or a shelter's device — reads as `Fresh` rather than throwing,
 * because refusing to render a card is worse than rendering the kindest band.
 */
export function deriveStalenessBand(
  lastConfirmedAt: Date,
  asOf: Date,
): StalenessBand {
  const age = daysBetween(lastConfirmedAt, asOf);
  for (const [band, upperBound] of THRESHOLDS) {
    if (age <= upperBound) return band;
  }
  return "Stale";
}
