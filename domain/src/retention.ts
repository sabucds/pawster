/**
 * How long each subscriber record may live.
 *
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) derives "every other retention
 * period from what the record is for, never guessed", and then says the thing that decides
 * where these figures live: **"a retention policy with no job behind it is a lie."**
 *
 * ## Why the periods are here and not beside the signup policy
 *
 * They started out in `web/src/lib/subscriber/policy.ts`, which is where they read most
 * naturally — the opt-in link's lifetime is a rule about a form. That placement made the
 * policy honest and the retention a lie, because ADR 0010 runs the purges "as a preamble to
 * the daily digest run, inside the same Cron Trigger and under the same Healthchecks.io
 * watchdog", and `digest/` cannot import `web/`. **A period declared somewhere the job that
 * enforces it cannot reach is a period nothing enforces.**
 *
 * `domain/` rather than `db/` because these are arithmetic over a clock and nothing else: no
 * I/O, no schema, `now` always an argument — the same test `upload.ts`'s
 * {@link UPLOAD_SESSION_TTL_MS} already passes for exactly the same reason, and it is the
 * neighbour to read for the shape. The queries that spend these cutoffs are in
 * `db/src/retention.ts`, which takes them as arguments and so needs nothing from here.
 *
 * What the placement preserves is the property {@link OPT_IN_TTL_MS} exists for: one constant
 * serves both the link's lifetime and the cutoff that destroys the row it names, across two
 * Workers rather than in two files that can disagree.
 */

/**
 * Seven days, and **one constant serves both** the opt-in link's lifetime and the purge
 * cutoff that destroys the row the link names.
 *
 * That is the design rather than a convenience. The row *is* what the link names, so a link
 * outliving its row is a link that finds nothing anyway; deriving {@link optInPurgeCutoff}
 * from the same figure makes "the link stops working exactly when the row is due for
 * destruction" true by construction. Two constants would have been two facts that can
 * disagree about a single moment — the mistake `db/`'s `uploadSessions` comment already names
 * about carrying a `createdAt` and an `expiresAt` side by side.
 *
 * ADR 0010's reason for the figure itself: "an unconfirmed opt-in is an address we hold no
 * consent for at all, so it is hard-deleted at seven days."
 */
export const OPT_IN_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * The trailing-day window the global opt-in ceiling and the per-address cooldown are both
 * counted over, and therefore how long an opt-in mail-ledger row is worth keeping.
 *
 * A rolling 24 hours rather than a calendar day, matching sign-in: a fixed reset hands an
 * attacker two full allocations back to back across the boundary, and 00:00 UTC is 20:00 in
 * Venezuela — the middle of the evening rather than a quiet hour.
 */
export const OPT_IN_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The instant before which pending opt-in rows are due for destruction; anything created at
 * or before it is gone.
 *
 * Derived from {@link OPT_IN_TTL_MS}, which is the point: this is the same fact as the link's
 * expiry, read from the other end.
 */
export function optInPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - OPT_IN_TTL_MS);
}

/**
 * The instant before which opt-in mail-ledger rows answer nothing — which is also the start
 * of the window the global ceiling is counted over, because those are the same moment.
 *
 * A **shorter** retention than the opt-in rows above, and the asymmetry is ADR 0010's rule
 * that every period is derived from what the record is for. A ledger row answers two
 * questions, both bounded by {@link OPT_IN_WINDOW_MS} — the global ceiling and the per-address
 * cooldown — so a row a day old answers nothing, and it is still a fingerprint of an address
 * the platform may hold no consent for. Keeping it to match the seven-day figure next door
 * would be retention by symmetry.
 *
 * One function for the window's start and the ledger's cutoff rather than two subtractions of
 * one constant, so a row cannot be dropped while a count can still see it.
 */
export function optInMailLedgerCutoff(now: Date): Date {
  return new Date(now.getTime() - OPT_IN_WINDOW_MS);
}

/**
 * Ninety days between unsubscribing and erasure, and **the automatic expiry is the whole
 * point of the grace period**.
 *
 * ADR 0010: the one-click unsubscribe has no confirmation page, deliberately, "so that a
 * mailbox provider can safely fetch it — which guarantees accidental unsubscribes from link
 * prefetchers and mis-taps. Erasing on the spot would turn every one of those into the
 * permanent loss of three saved searches. So unsubscribe stops sending immediately and leaves
 * the subscriber dormant for 90 days, after which the row erases itself."
 *
 * The sentence that follows is the reason this is a constant with a job behind it rather than
 * a policy anybody remembers: "the automatic expiry is what stops the grace period from
 * quietly becoming indefinite retention." A dormant row nothing deletes is retention with a
 * nicer name.
 *
 * **Measured from the unsubscribe, not from the last digest.** The record is being kept for
 * exactly one purpose — undoing a click that may have been an accident — so the clock starts
 * at the click.
 */
export const UNSUBSCRIBE_GRACE_MS = 90 * 24 * 60 * 60_000;

/** The instant before which an unsubscribed subscriber is due to be erased entirely. */
export function unsubscribedErasureCutoff(now: Date): Date {
  return new Date(now.getTime() - UNSUBSCRIBE_GRACE_MS);
}

/**
 * How long a subscriber may go without ever matching anything before the platform writes to
 * say so, and to hand them a link that still works.
 *
 * ADR 0010: "A subscriber who never matches anything receives no digest and therefore no
 * footer, so the opt-in success page and the 90-day 'still nothing' nudge both carry the
 * manage link, guaranteeing a live link at least quarterly." Without it there is a subscriber
 * holding consent we act on and no route back to their own data — which would make the manage
 * page a subject-access response nobody can reach.
 *
 * The same ninety days as {@link UNSUBSCRIBE_GRACE_MS} and deliberately **not** derived from
 * it, the call `web/src/lib/subscriber/policy.ts` makes between `OPT_IN_MAIL_COOLDOWN_MS` and
 * `OPT_IN_WINDOW_MS`: two facts that happen to coincide. One is how long a mistaken click may
 * be undone; the other is how long silence is tolerable before it needs explaining. Moving
 * either should not move the other.
 *
 * Measured from the opt-in, because that is when the silence started.
 */
export const NEVER_MATCHED_NUDGE_MS = 90 * 24 * 60 * 60_000;

/**
 * The instant before which a subscriber who has never received a digest is owed their one
 * nudge.
 *
 * "One" is enforced by the row rather than by this figure — `subscribers.nudged_at` is
 * written when the nudge goes out and the query skips anybody who has one. A cutoff alone
 * would nudge the same silent subscriber every single day.
 */
export function neverMatchedNudgeCutoff(now: Date): Date {
  return new Date(now.getTime() - NEVER_MATCHED_NUDGE_MS);
}
