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
