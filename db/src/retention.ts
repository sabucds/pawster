/**
 * The deletes ADR 0010's retention periods spend.
 *
 * The periods themselves are in `@pawster/domain`'s `retention.ts`, which records why they
 * are not beside the signup policy that reads them. What is here is only the two statements,
 * and they take their cutoffs as arguments — so this file needs nothing from `domain/` and
 * the one place a period is written down stays the one place.
 *
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) runs both of these "as a
 * preamble to the daily digest run, inside the same Cron Trigger and under the same
 * Healthchecks.io watchdog", because "a retention policy with no job behind it is a lie, and
 * a second schedule would be a second thing that can die silently". `digest/src/index.ts` is
 * that preamble.
 *
 * No Drizzle client is built here — every function takes one, for the reason
 * `db/src/index.ts` gives.
 */

import { lt } from "drizzle-orm";
import type { Database } from "./index.ts";
import { optInMails, pendingOptIns } from "./schema.ts";

/** What one run of {@link runSubscriberPurges} destroyed, for the run's own record. */
export interface PurgeCounts {
  /** Unconfirmed opt-ins, and with them the only IP the subscriber model holds. */
  readonly optIns: number;
  /** Opt-in mail-ledger rows past the window they serve. */
  readonly mailLedger: number;
}

/**
 * Destroy every unconfirmed opt-in past its seven days, and with it the only IP the
 * subscriber model holds (ADR 0010).
 *
 * Returns a count rather than `void`, and that is not bookkeeping for its own sake: ADR 0010
 * asks the purges to write "their counts into the `Digest Run` summary", because a purge that
 * silently stopped finding rows looks exactly like a purge with nothing to do.
 */
export async function purgeExpiredOptIns(
  db: Database,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .delete(pendingOptIns)
    .where(lt(pendingOptIns.createdAt, cutoff))
    .returning({ tokenHash: pendingOptIns.tokenHash });
  return rows.length;
}

/** Drop opt-in mail-ledger rows older than the window they exist to serve. */
export async function purgeOptInMailLedger(
  db: Database,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .delete(optInMails)
    .where(lt(optInMails.sentAt, cutoff))
    .returning({ id: optInMails.id });
  return rows.length;
}

/**
 * Every subscriber purge ADR 0010 owes, in one call.
 *
 * One function rather than two calls at the cron, because "the purges run as a preamble to
 * the daily digest run" is a single obligation and a caller that remembered one of them would
 * satisfy neither the ADR nor a reader. When Retirement and Erasure add their own clocks —
 * the 90-day dormant subscriber, the 90-day delivery record — they land here and the cron
 * does not change.
 *
 * The two cutoffs are passed in rather than computed, so this file still holds no period.
 */
export async function runSubscriberPurges(
  db: Database,
  cutoffs: { readonly optIns: Date; readonly mailLedger: Date },
): Promise<PurgeCounts> {
  return {
    optIns: await purgeExpiredOptIns(db, cutoffs.optIns),
    mailLedger: await purgeOptInMailLedger(db, cutoffs.mailLedger),
  };
}
