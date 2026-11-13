/**
 * The parts of digest delivery that are arithmetic rather than I/O
 * ([ADR 0009](../../docs/adr/0009-digest-delivery-and-retry.md)). They live here so the
 * "exactly one email per recipient under idempotency key X" assertion has something
 * deterministic to assert against.
 */

import { adoptionUnitOf, unitsOf } from "./filter-index.ts";
import type { AnimalAxes, SubscriptionCriteria } from "./matching.ts";
import { matches } from "./matching.ts";

/** The day a run covers, as `YYYY-MM-DD`. One shard per day, one run per shard. */
export type DigestPeriod = string;

/**
 * Resend's idempotency key for one recipient in one run. Deterministic, so a redelivered
 * queue message is a no-op for anyone already sent, and per-recipient, so a resumed run
 * neither 409s nor re-sends the whole shard.
 */
export function digestIdempotencyKey(
  period: DigestPeriod,
  subscriberId: string,
): string {
  return `digest/${period}/${subscriberId}`;
}

/**
 * Sends a single shard may spend. Resend's Free plan allows 100 emails/day across every
 * message the platform sends, and 30 are reserved for shelter one-time codes, opt-in mail
 * and confirmation nudges: a late digest is a non-event, a shelter that cannot sign in is
 * an outage.
 */
export const DIGEST_DAILY_BUDGET = 100 - 30;

/** A listed animal as the digest matches it: its axes, plus what groups it into a unit. */
export interface DigestAnimal extends AnimalAxes {
  readonly id: string;
  readonly bondedGroupId: string | null;
}

/**
 * The units one subscription should be sent today, each as its members' ids in id order.
 *
 * ADR 0009's candidate set, minus the "currently listed" clause, which the caller has already
 * applied with `isListed`: *matches the criteria* AND *not already in this subscription's
 * sent-set*. Matching takes the adoption **unit** (#59), so a bonded group is one entry and
 * is matched as a group, through the same grouping and the same region normalisation the
 * listing uses.
 *
 * **A unit counts as sent only when every member has been sent.** A member who joins a group
 * after it went out makes the group news again; that is the rule the spec left open, and it
 * errs towards one repeated card rather than a dog nobody is told about.
 */
export function digestCandidates(
  listed: readonly DigestAnimal[],
  criteria: SubscriptionCriteria,
  sent: ReadonlySet<string>,
  now: Date,
): string[][] {
  return unitsOf(listed)
    .filter((unit) => !unit.every((animal) => sent.has(animal.id)))
    .filter((unit) => matches(criteria, adoptionUnitOf(unit), now))
    .map((unit) => unit.map((animal) => animal.id));
}

/** At most this many rows under one search (issue #10's structure, kept by the #15 prototype). */
export const DIGEST_SECTION_CAP = 12;
/** At most this many rows in one email, across all of a subscriber's searches. */
export const DIGEST_EMAIL_CAP = 24;

/** One search's candidates, in the order {@link digestCandidates} returned them. */
export interface DigestSearchMatches {
  readonly subscriptionId: string;
  readonly units: readonly string[][];
}

/** What one search's section of the email carries. */
export interface ComposedSection {
  readonly subscriptionId: string;
  /** The rows shown under this search, each a unit's member ids. */
  readonly units: string[][];
  /**
   * Units this search matched that an earlier section of the same email already shows. Not
   * shown twice, but written to this search's sent-set too, so neither search offers them again.
   */
  readonly repeats: string[][];
  /** Candidates that did not fit. Not shown and not marked sent, so they arrive next time. */
  readonly more: number;
}

/**
 * Chooses what one email shows out of everything a subscriber's searches matched, filling
 * sections in the order given (slot order) up to {@link DIGEST_SECTION_CAP} each and
 * {@link DIGEST_EMAIL_CAP} in all.
 *
 * What is cut is only *not shown*: the sent-set is written from `units` and `repeats`, so the
 * overflow stays new and is offered again by the next run.
 */
export function composeDigest(
  searches: readonly DigestSearchMatches[],
): ComposedSection[] {
  const shown = new Set<string>();
  return searches.map((search) => {
    const units: string[][] = [];
    const repeats: string[][] = [];
    let more = 0;
    for (const unit of search.units) {
      const key = unit.join(",");
      if (shown.has(key)) repeats.push(unit);
      else if (units.length < DIGEST_SECTION_CAP && shown.size < DIGEST_EMAIL_CAP) {
        units.push(unit);
        shown.add(key);
      } else more++;
    }
    return { subscriptionId: search.subscriptionId, units, repeats, more };
  });
}
