/**
 * Every query the subscriber's *own* surfaces make: the manage page, the unsubscribe landing
 * page, erasure, and the retirement a Resend webhook writes.
 *
 * A module beside [`store.ts`](store.ts) rather than inside it, and the split is the one that
 * file already declares: it holds "every query the subscriber path makes" where *the path* is
 * signup — five limits counted over three tables, all of them reads or appends, and its
 * comment closes by saying "nothing on the signup path deletes". What is here is the opposite
 * shape. Every function below writes, two of them destroy, and none of them is reachable
 * without a signed link.
 *
 * ## The one thing this module does not do
 *
 * It never decides *whether* a caller may act. That is the route's job, because the credential
 * is a signed link and verifying one is pure arithmetic over a token
 * (`@pawster/domain`'s `subscriber-links.ts`) — so it is testable without a database and is
 * tested there. A function here that took a token would have put the security boundary behind
 * a query.
 *
 * The one exception proves the shape: {@link unsubscribeSubscriber} returns the *new* manage
 * token version, because rotating it is the write, and the caller cannot know it without
 * asking the row.
 */

import type { Database } from "@pawster/db";
import {
  doNotContact,
  subscribers,
  subscriptions,
} from "@pawster/db";
import type { SubscriptionCriteria } from "@pawster/domain";
import { readCriteria } from "@pawster/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { normaliseAddress } from "./crypto.ts";
import type { SendDay, SubscriberLocale } from "./policy.ts";

/**
 * One of a subscriber's saved searches, as their own page shows it.
 *
 * The criteria arrive parsed rather than as the stored string, and through `readCriteria()`
 * rather than `JSON.parse` — the rule `subscriptions.criteria` states: a value that was legal
 * when it was written and stopped being legal after a vocabulary change must not reach a page
 * as a checkbox nobody can act on.
 */
export interface ManagedSubscription {
  readonly id: string;
  /** 0, 1 or 2 — the slot, which is the name the page can call this search by. */
  readonly slot: number;
  readonly criteria: SubscriptionCriteria;
  readonly createdAt: Date;
}

/**
 * **Everything Pawster holds about one subscriber**, which is the whole point of the type.
 *
 * ADR 0010: "The manage page is the subject-access response. Address, up to three
 * subscriptions, send day, opt-in date, last-sent date is the whole of what we hold; an export
 * flow would show nothing the page does not. One page, with the delete button on it, replaces
 * a request process we would otherwise have to build and staff."
 *
 * So this interface is deliberately **column-for-column with `subscribers`**, including the
 * fields a subscriber would never think to ask for — when we last nudged them, whether we
 * retired them and why. A subject-access response that quietly omitted the platform's own
 * notes about somebody would be the ordinary way this promise gets broken, and the way to
 * keep it is to make the omission visible here: a column added to the table and not to this
 * type is a column the page stops disclosing, and the test that counts them fails.
 *
 * The `id` and `manageTokenVersion` are the exception, and they are here for the same honesty:
 * they are not facts *about* the subscriber, they are the address of the row and the
 * generation of their link. The page says so rather than hiding them.
 */
export interface ManageView {
  readonly id: string;
  readonly email: string;
  readonly sendDay: SendDay;
  readonly locale: SubscriberLocale;
  readonly optedInAt: Date;
  readonly lastDigestAt: Date | null;
  readonly unsubscribedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly retirementReason: "bounce" | "complaint" | null;
  readonly nudgedAt: Date | null;
  readonly manageTokenVersion: number;
  readonly subscriptions: readonly ManagedSubscription[];
}

/**
 * The subject-access response, as one read plus one.
 *
 * `null` when there is no such subscriber, which covers an id that was never real and one
 * whose row an erasure or the ninety-day purge has taken. All three are the same sentence to
 * whoever followed the link — there is nothing left to tell them apart with — and the route
 * says it once.
 */
export async function readManageView(
  db: Database,
  subscriberId: string,
): Promise<ManageView | null> {
  const [row] = await db
    .select()
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId))
    .limit(1);
  if (row === undefined) return null;

  const saved = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.subscriberId, subscriberId))
    .orderBy(subscriptions.slot);

  return {
    id: row.id,
    email: row.email,
    sendDay: row.sendDay as SendDay,
    locale: row.locale,
    optedInAt: row.optedInAt,
    lastDigestAt: row.lastDigestAt,
    unsubscribedAt: row.unsubscribedAt,
    retiredAt: row.retiredAt,
    retirementReason: row.retirementReason,
    nudgedAt: row.nudgedAt,
    manageTokenVersion: row.manageTokenVersion,
    subscriptions: saved.map((subscription) => ({
      id: subscription.id,
      slot: subscription.slot,
      criteria: readCriteria(subscription.criteria),
      createdAt: subscription.createdAt,
    })),
  };
}

/**
 * Stop sending, start the ninety-day clock, and rotate the manage link. Returns the version
 * now live, or `null` if there is no such subscriber.
 *
 * **Idempotent on the timestamp and not on the rotation**, which is the one subtlety here.
 * `unsubscribed_at` is written only while it is `NULL`, so a second visit to the same link —
 * a prefetcher following it, then the person — does not push the erasure date ninety days
 * further out each time. That would make the grace period unbounded for exactly the
 * subscribers who unsubscribed most emphatically.
 *
 * The version bumps every time regardless, and that is deliberate rather than sloppy: the
 * rotation exists so that a manage link which has been *forwarded, logged or scraped* stops
 * working the moment its owner says stop, and a repeat click is another chance to say it.
 * Nothing is lost by bumping twice — the subscriber's route back is the delete button on the
 * unsubscribe landing page itself (ADR 0010), not a manage link they are holding.
 *
 * One statement, so two concurrent unsubscribes cannot both read version 0 and both write 1.
 */
export async function unsubscribeSubscriber(
  db: Database,
  subscriberId: string,
  now: Date,
): Promise<number | null> {
  const [row] = await db
    .update(subscribers)
    .set({
      unsubscribedAt: sql`coalesce(${subscribers.unsubscribedAt}, ${now.getTime()})`,
      manageTokenVersion: sql`${subscribers.manageTokenVersion} + 1`,
    })
    .where(eq(subscribers.id, subscriberId))
    .returning({ version: subscribers.manageTokenVersion });
  return row?.version ?? null;
}

/**
 * The platform's own decision to stop sending (`CONTEXT.md`, *Retirement*).
 *
 * Distinct from unsubscribing and stored separately, because they are two different facts —
 * one the subscriber's and one ours — and a single column would have made "did they ask us to
 * stop, or did their mailbox break?" unanswerable. The digest's shard excludes both.
 *
 * **Writing the Do-Not-Contact entry is not done here**, even though a complaint earns one.
 * The digest is computed under `DO_NOT_CONTACT_PEPPER` over the *address*, and the caller is
 * the one holding both; keeping the decision in the route means this function needs no secret
 * and the `do_not_contact` write stays in `store.ts`'s `refuseContact()`, which already owns
 * that table's construction.
 *
 * Idempotent on the timestamp for {@link unsubscribeSubscriber}'s reason — a provider that
 * delivers the same webhook twice must not move the date — but the reason is allowed to
 * *escalate*: an address that bounced and later complained is a complaint, because that is the
 * permanent one. It never de-escalates.
 */
export async function retireSubscriber(
  db: Database,
  subscriberId: string,
  reason: "bounce" | "complaint",
  now: Date,
): Promise<void> {
  await db
    .update(subscribers)
    .set({
      retiredAt: sql`coalesce(${subscribers.retiredAt}, ${now.getTime()})`,
      retirementReason:
        reason === "complaint"
          ? "complaint"
          : sql`coalesce(${subscribers.retirementReason}, 'bounce')`,
    })
    .where(eq(subscribers.id, subscriberId));
}

/**
 * The subscriber this address belongs to, for the webhook that only ever learns an address.
 *
 * Returns the id and the address as stored. Normalised on the way in, because Resend reports
 * whatever casing the original send used and a subscriber row is keyed by the normalised form
 * — the mismatch would silently retire nobody, which is the failure direction that keeps
 * mailing someone who reported us as spam.
 */
export async function findSubscriberByEmail(
  db: Database,
  email: string,
): Promise<{ id: string; email: string } | null> {
  const [row] = await db
    .select({ id: subscribers.id, email: subscribers.email })
    .from(subscribers)
    .where(eq(subscribers.email, normaliseAddress(email)))
    .limit(1);
  return row ?? null;
}

/**
 * Whether this digest is already on the Do-Not-Contact list.
 *
 * Used by the retirement path to keep `refuseContact()`'s insert honest about what it
 * reports, and by nothing else — the signup form asks the same question inside
 * `readSignupState()`, in one pass with four other counts, and must keep doing so.
 */
export async function isRefused(db: Database, digest: string): Promise<boolean> {
  const [row] = await db
    .select({ digest: doNotContact.digest })
    .from(doNotContact)
    .where(eq(doNotContact.digest, digest))
    .limit(1);
  return row !== undefined;
}

/**
 * Subscribers who are still being sent to: neither unsubscribed nor retired.
 *
 * Exists for the tests rather than for a page, and earns its place there: several of them
 * assert that a path stopped the sending, and asking the same question the digest's shard asks
 * is stronger than re-deriving the two clauses in a test where they could quietly drift apart
 * from the query that matters.
 */
export async function countMailable(db: Database): Promise<number> {
  const rows = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(
      and(isNull(subscribers.unsubscribedAt), isNull(subscribers.retiredAt)),
    );
  return rows.length;
}
