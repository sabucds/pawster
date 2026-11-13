/**
 * The deletes ADR 0010's retention periods spend.
 *
 * The periods themselves are in `@pawster/domain`'s `retention.ts`, which records why they
 * are not beside the signup policy that reads them. What is here is only the statements, and
 * they take their cutoffs as arguments — so this file needs nothing from `domain/` and the one
 * place a period is written down stays the one place.
 *
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) runs all of these "as a
 * preamble to the daily digest run, inside the same Cron Trigger and under the same
 * Healthchecks.io watchdog", because "a retention policy with no job behind it is a lie, and
 * a second schedule would be a second thing that can die silently". `digest/src/index.ts` is
 * that preamble.
 *
 * No Drizzle client is built here — every function takes one, for the reason
 * `db/src/index.ts` gives.
 */

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Database } from "./index.ts";
import {
  optInMails,
  pendingOptIns,
  subscribers,
  subscriptions,
} from "./schema.ts";

/** What one run of {@link runSubscriberPurges} destroyed, for the run's own record. */
export interface PurgeCounts {
  /** Unconfirmed opt-ins, and with them the only IP the subscriber model holds. */
  readonly optIns: number;
  /** Opt-in mail-ledger rows past the window they serve. */
  readonly mailLedger: number;
  /** Subscribers erased at the end of their ninety-day unsubscribe grace period. */
  readonly erasedSubscribers: number;
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
 * Destroy everything Pawster holds about one subscriber (`CONTEXT.md`, *Erasure*).
 *
 * **What it leaves behind is a Do-Not-Contact entry, and only where one is owed** — which is
 * why writing that entry is not this function's job. A DNC digest can only be computed under
 * `DO_NOT_CONTACT_PEPPER`, a secret `web/` holds and `digest/` deliberately does not, and the
 * entry is written at *retirement* rather than at erasure: the complaint is the fact that
 * earns it, and by the time a row is erased the address may be gone. So the entry is already
 * there when this runs, and this never has to decide.
 *
 * Children before the parent, because `subscriptions.subscriber_id` is a foreign key.
 *
 * **Unredeemed opt-ins for the same address go too.** They are a separate record from the
 * subscriber — an address the platform holds no consent for, keyed by a token rather than by
 * an id — so nothing about deleting the subscriber would take them, and leaving them would
 * leave a live link that recreates the subscriber a week after an erasure.
 *
 * **`opt_in_mails` rows are deliberately left to their own 24-hour purge**, and this is the
 * one thing erasure does not destroy. The row holds no address: only
 * `HMAC(SUBSCRIBER_SECRET, "subscriber:" || address)`, and it exists to bound the *platform's*
 * daily mail ceiling rather than to say anything about a person. Deleting it here would turn
 * erasure into a rate-limit reset — an address could spend one of the platform's six daily
 * opt-in mails, erase itself, and spend another — which is the mailbomb the ceiling exists to
 * refuse. It is gone within the day either way.
 */
export async function eraseSubscriber(
  db: Database,
  subject: { readonly subscriberId: string; readonly email: string },
): Promise<void> {
  await db
    .delete(subscriptions)
    .where(eq(subscriptions.subscriberId, subject.subscriberId));
  await db.delete(subscribers).where(eq(subscribers.id, subject.subscriberId));
  await db.delete(pendingOptIns).where(eq(pendingOptIns.email, subject.email));
}

/**
 * Erase every subscriber whose ninety-day unsubscribe grace period has run out.
 *
 * ADR 0010: unsubscribe "stops sending immediately and leaves the subscriber dormant for 90
 * days, after which the row erases itself... The automatic expiry is what stops the grace
 * period from quietly becoming indefinite retention." **This function is that sentence**, and
 * without it `unsubscribed_at` would be a column that means "keep forever, but quietly".
 *
 * The rows are read before they are deleted rather than deleted in one statement, because
 * {@link eraseSubscriber} needs each subscriber's address to take their unredeemed opt-in
 * links with them — and a `DELETE ... RETURNING email` would have handed back the address of
 * a row already gone, leaving the link behind if the second statement failed. Reading first
 * costs one query for a set that is empty on almost every run.
 */
export async function purgeUnsubscribedSubscribers(
  db: Database,
  cutoff: Date,
): Promise<number> {
  const due = await db
    .select({ id: subscribers.id, email: subscribers.email })
    .from(subscribers)
    .where(
      and(
        isNotNull(subscribers.unsubscribedAt),
        lt(subscribers.unsubscribedAt, cutoff),
      ),
    );

  for (const subscriber of due) {
    await eraseSubscriber(db, {
      subscriberId: subscriber.id,
      email: subscriber.email,
    });
  }
  return due.length;
}

/**
 * The subscribers owed the ninety-day "still nothing" nudge: opted in before the cutoff,
 * never sent a digest, never nudged, and still subscribed.
 *
 * Reading this here rather than in `digest/` keeps the four clauses in one place, and the
 * fourth is the one worth naming: **a subscriber who has unsubscribed or been retired is not
 * owed a nudge**, and a query that forgot the clause would mail somebody who asked us to stop
 * — using, of all things, the mechanism that exists to hand them a working manage link.
 *
 * `last_digest_at IS NULL` is "never matched anything" read from the only column that can
 * answer it before the digest producer exists (#63): nothing has ever been sent. Once the
 * producer lands, a subscriber whose searches match nothing still has no digest and therefore
 * still no row, so the clause does not change.
 */
export async function findNeverMatchedSubscribers(
  db: Database,
  cutoff: Date,
  limit: number,
): Promise<{ id: string; email: string; manageTokenVersion: number }[]> {
  return await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
      manageTokenVersion: subscribers.manageTokenVersion,
    })
    .from(subscribers)
    .where(
      and(
        lt(subscribers.optedInAt, cutoff),
        isNull(subscribers.lastDigestAt),
        isNull(subscribers.nudgedAt),
        isNull(subscribers.unsubscribedAt),
        isNull(subscribers.retiredAt),
      ),
    )
    .limit(limit);
}

/**
 * Record that the one nudge has been sent.
 *
 * Written *after* the send rather than before it, the opposite of `recordOptInMail()`. That
 * ledger is a rate limit, where a failed send must still cost the caller its allowance; this
 * is a promise to a subscriber that they will be told, once, that nothing matched — and a
 * nudge marked sent but never delivered is a subscriber left with no working link, which is
 * the outcome the whole mechanism exists to prevent. A send that fails is retried on the next
 * run, and the column is what stops a successful one from repeating.
 */
export async function recordNudge(
  db: Database,
  subscriberId: string,
  now: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({ nudgedAt: now })
    .where(eq(subscribers.id, subscriberId));
}

/**
 * Every subscriber purge ADR 0010 owes, in one call.
 *
 * One function rather than three calls at the cron, because "the purges run as a preamble to
 * the daily digest run" is a single obligation and a caller that remembered two of them would
 * satisfy neither the ADR nor a reader.
 *
 * The cutoffs are passed in rather than computed, so this file still holds no period.
 */
export async function runSubscriberPurges(
  db: Database,
  cutoffs: {
    readonly optIns: Date;
    readonly mailLedger: Date;
    readonly unsubscribed: Date;
  },
): Promise<PurgeCounts> {
  return {
    optIns: await purgeExpiredOptIns(db, cutoffs.optIns),
    mailLedger: await purgeOptInMailLedger(db, cutoffs.mailLedger),
    erasedSubscribers: await purgeUnsubscribedSubscribers(
      db,
      cutoffs.unsubscribed,
    ),
  };
}
