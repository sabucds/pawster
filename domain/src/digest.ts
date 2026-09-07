/**
 * The parts of digest delivery that are arithmetic rather than I/O
 * ([ADR 0009](../../docs/adr/0009-digest-delivery-and-retry.md)). They live here so the
 * "exactly one email per recipient under idempotency key X" assertion has something
 * deterministic to assert against.
 */

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
