/**
 * Every query the subscriber path makes, and nothing else.
 *
 * The same split [`../auth/store.ts`](../auth/store.ts) makes and for the same reason: the
 * signup decision is five limits counted over three tables, and keeping the counting here is
 * what lets `refuseSignup()` stay a pure function with a table test. An endpoint assembling
 * its own `COUNT(*)`s would have put the policy back at the call site.
 *
 * No Drizzle client is built here — every function takes one, because `db/src/index.ts`
 * requires it to be constructed inside the request handler and a module that built its own
 * is the exact shape `scripts/check-source-rules.mjs` fails the build over.
 *
 * ## Which table each limit is counted over, and why it is not one table
 *
 * `pending_opt_ins` is the outstanding link and `opt_in_mails` is the history, the same way
 * `one_time_codes` and `sign_in_requests` divide the shelter path. The division is forced
 * here rather than merely tidy:
 *
 * - **The global ceiling and the per-address cooldown read `opt_in_mails`**, because a
 *   pending row is *deleted* the moment its link is followed. Counted over pending rows, six
 *   sends all redeemed would read as zero and the next six would go out inside the same day.
 * - **The per-IP limit reads `pending_opt_ins`**, because
 *   [ADR 0010](../../../../docs/adr/0010-subscriber-data-retention.md) allows the subscriber
 *   model exactly one table holding an IP and `opt_in_mails` is not it. `policy.ts`'s
 *   `SIGNUP_IP_REQUEST_LIMIT` records what that costs.
 *
 * **The purges that destroy both tables' rows are not here.** They are in
 * `db/src/retention.ts`, called from `digest/`'s `scheduled()` preamble, because ADR 0010 puts
 * them inside the digest's Cron Trigger and `digest/` cannot import `web/`. That file records
 * the placement; what matters from this end is that nothing on the signup path deletes, so
 * every query below is a read or an append.
 */

import type { Database } from "@pawster/db";
import {
  doNotContact,
  optInMails,
  pendingOptIns,
  subscribers,
  subscriptions,
} from "@pawster/db";
import type { PendingOptIn } from "@pawster/db";
import type { SubscriptionCriteria } from "@pawster/domain";
import { readCriteria, writeCriteria } from "@pawster/domain";
import { and, count, desc, eq, gte } from "drizzle-orm";
import { normaliseAddress } from "./crypto.ts";
import type {
  SendDay,
  SendDayLoad,
  SignupState,
  SubscriberLocale,
} from "./policy.ts";
import {
  MAX_SUBSCRIPTIONS_PER_SUBSCRIBER,
  SEND_DAYS,
  assignSendDay,
  optInWindowStart,
  signupIpWindowStart,
} from "./policy.ts";

/**
 * What {@link readSignupState} needs, all of it already hashed by the endpoint.
 *
 * Every field is required, unlike `readMailBudgetUsage()`'s nullable `shelterId`. That
 * asymmetry is worth a line, because the nullable version was written first and was dead
 * code: sign-in has to do the same work for an address that resolves to nobody as for one
 * that does, since telling those apart *is* the enumeration answer there — but a signup with
 * no usable address never reaches this function at all. `suscribir.ts` answers
 * `correo-invalido` from the parse, before a hash is taken or a query is run, and that is
 * allowed precisely because the shape of an address reveals nothing about its owner.
 */
export interface SignupSubject {
  /** The submitted address, normalised. */
  readonly email: string;
  /** `hashSubscriberEmail()` of the same address. */
  readonly emailHash: string;
  /** `doNotContactDigest()` of the same address. */
  readonly doNotContactDigest: string;
  /** `hashSignupIp()` of the caller. An unattributable caller shares one bucket. */
  readonly ipHash: string;
}

/** Everything `refuseSignup()` decides on, in one pass. */
export async function readSignupState(
  db: Database,
  subject: SignupSubject,
  now: Date,
): Promise<SignupState> {
  const mailWindowStart = optInWindowStart(now);

  const [global] = await db
    .select({ n: count() })
    .from(optInMails)
    .where(gte(optInMails.sentAt, mailWindowStart));

  const [ip] = await db
    .select({ n: count() })
    .from(pendingOptIns)
    .where(
      and(
        eq(pendingOptIns.ipHash, subject.ipHash),
        gte(pendingOptIns.createdAt, signupIpWindowStart(now)),
      ),
    );

  const [refused] = await db
    .select({ digest: doNotContact.digest })
    .from(doNotContact)
    .where(eq(doNotContact.digest, subject.doNotContactDigest))
    .limit(1);

  /**
   * The most recent opt-in mail to this address, read without a time bound.
   *
   * Bounding it by the 24-hour window would be harmless, since the cooldown *is* 24 hours —
   * and it would be a second place two constants have to agree about one figure.
   * `MAX(sent_at)` over an indexed column costs the same either way.
   */
  const [lastMail] = await db
    .select({ at: optInMails.sentAt })
    .from(optInMails)
    .where(eq(optInMails.emailHash, subject.emailHash))
    .orderBy(desc(optInMails.sentAt))
    .limit(1);

  return {
    optInMailsInWindow: global?.n ?? 0,
    ipRequestsInWindow: ip?.n ?? 0,
    onDoNotContact: refused !== undefined,
    subscriptionCount: await countSubscriptionsFor(db, subject.email),
    lastOptInMailAt: lastMail?.at ?? null,
  };
}

/**
 * How many subscriptions the address already holds. Zero for an address that is not a
 * subscriber, which is the same answer and deliberately not a different one.
 */
export async function countSubscriptionsFor(
  db: Database,
  email: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(subscriptions)
    .innerJoin(subscribers, eq(subscriptions.subscriberId, subscribers.id))
    .where(eq(subscribers.email, normaliseAddress(email)));
  return row?.n ?? 0;
}

/**
 * How many subscribers sit on each weekday, as the seven-tuple `assignSendDay()` requires.
 *
 * **The zero-fill is the whole point of this function.** `GROUP BY send_day` returns a row
 * per day that *has* subscribers, so an empty platform returns nothing and a platform whose
 * Wednesdays are all unsubscribed returns six rows. Handed straight to `assignSendDay()` that
 * is either a thrown length check — which is the good outcome, and why the check is there —
 * or, once someone quiets the throw with a cast, a table where index 3 means Thursday's
 * count. The days with no subscribers are exactly the days a new subscriber should be given,
 * so dropping them inverts the function.
 */
export async function readSendDayLoad(db: Database): Promise<SendDayLoad> {
  const rows = await db
    .select({ day: subscribers.sendDay, n: count() })
    .from(subscribers)
    .groupBy(subscribers.sendDay);

  const load: SendDayLoad = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    // A day outside 0-6 cannot come from `assignSendDay`, but the column is a plain integer
    // and a hand-edited row must not silently shift another day's count.
    if (SEND_DAYS.includes(row.day as SendDay)) load[row.day as SendDay] = row.n;
  }
  return load;
}

export interface PendingOptInInput {
  readonly tokenHash: string;
  /** Normalised, because this is the address a subscriber row will be created with. */
  readonly email: string;
  readonly criteria: SubscriptionCriteria;
  readonly locale: SubscriberLocale;
  readonly ipHash: string;
}

/**
 * Write the unconfirmed opt-in, and nothing that can be mailed.
 *
 * This function is the ticket's first acceptance criterion, and like `registerShelter()`'s
 * missing verification row it satisfies it by *not writing* rather than by writing something:
 * the digest reads `subscribers`, and there is no subscriber here. There is no pending state
 * to set on one and no flag for a later path to remember to clear.
 *
 * A second signup for an address that already has a live pending row writes a second row
 * rather than superseding the first, so both links work. That is deliberate: the 24-hour
 * cooldown means the two are a day apart, and the second was almost certainly asked for
 * because the first mail was not found — retiring it would break the link in the message
 * that does eventually surface.
 */
export async function createPendingOptIn(
  db: Database,
  input: PendingOptInInput,
  now: Date,
): Promise<void> {
  await db.insert(pendingOptIns).values({
    tokenHash: input.tokenHash,
    email: input.email,
    criteria: writeCriteria(input.criteria),
    locale: input.locale,
    ipHash: input.ipHash,
    createdAt: now,
  });
}

/**
 * Append one row to the mail ledger.
 *
 * Written **before** the send, so a Resend failure still costs this address its 24 hours and
 * the platform one of its six. The other way round, a caller could retry without limit
 * against the one unauthenticated endpoint here that spends money — the same ordering
 * `recordSignInRequest()` takes, for the same reason.
 */
export async function recordOptInMail(
  db: Database,
  emailHash: string,
  now: Date,
): Promise<void> {
  await db.insert(optInMails).values({
    id: crypto.randomUUID(),
    emailHash,
    sentAt: now,
  });
}

/** The pending opt-in this token names, without consuming it. */
export async function findPendingOptIn(
  db: Database,
  tokenHash: string,
): Promise<PendingOptIn | null> {
  const [row] = await db
    .select()
    .from(pendingOptIns)
    .where(eq(pendingOptIns.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

/**
 * Consume the pending opt-in this token names, or `null` if there is not one.
 *
 * **One statement, and that is what makes the link single-use.** The obvious form — read the
 * row, act on it, delete it — is a race on exactly the property being enforced: two `POST`s
 * arriving together both find the row, both write a subscription, and the "single-use" link
 * has been used twice. `DELETE ... RETURNING` is decided by SQLite, which serialises writes,
 * so of two concurrent redemptions one gets the row and the other gets `null`.
 *
 * `null` therefore covers a token that was never real, one whose row the seven-day purge took,
 * and one a moment ago consumed. All three are the same sentence to the subscriber, which is
 * right: none of them is a state anybody can act on except by signing up again.
 */
export async function consumePendingOptIn(
  db: Database,
  tokenHash: string,
): Promise<PendingOptIn | null> {
  const [row] = await db
    .delete(pendingOptIns)
    .where(eq(pendingOptIns.tokenHash, tokenHash))
    .returning();
  return row ?? null;
}

export interface OptedIn {
  readonly subscriberId: string;
  /** The weekday this subscriber's digest goes out on, assigned or already held. */
  readonly sendDay: SendDay;
  /** Which of the three slots the new subscription took. */
  readonly slot: number;
}

/**
 * Turn a consumed opt-in into a subscription, creating the subscriber if this is their first.
 *
 * Returns `null` when every slot is taken. That is the *enforced* cap rather than the
 * predicted one — `refuseOptIn()` has already asked the same question and answered it from a
 * count, and this answers it from the unique index, which is the answer that holds when two
 * links are redeemed in the same second.
 *
 * The send day is assigned **only for a new subscriber**, and never revisited afterwards.
 * `CONTEXT.md` makes it "fixed at opt-in and the same every week", and a second subscription
 * that moved the day would move the first one's mail too — three saved searches arrive in one
 * email, so the day belongs to the person and not to the search.
 */
export async function optIn(
  db: Database,
  pending: PendingOptIn,
  now: Date,
): Promise<OptedIn | null> {
  const email = normaliseAddress(pending.email);

  /**
   * `onConflictDoNothing` rather than a read followed by an insert, because two links for one
   * new address redeemed together would otherwise both insert and one would fail on the
   * unique index. The conflict target is the address, so the loser simply finds the row the
   * winner wrote — and the send day it finds is the winner's, which is correct: the day is
   * the subscriber's, and the second redemption is adding a search to an existing one.
   */
  const [created] = await db
    .insert(subscribers)
    .values({
      id: crypto.randomUUID(),
      email,
      sendDay: assignSendDay(await readSendDayLoad(db)),
      optedInAt: now,
      locale: pending.locale,
    })
    .onConflictDoNothing({ target: subscribers.email })
    .returning({ id: subscribers.id, sendDay: subscribers.sendDay });

  const subscriber =
    created ??
    (
      await db
        .select({ id: subscribers.id, sendDay: subscribers.sendDay })
        .from(subscribers)
        .where(eq(subscribers.email, email))
        .limit(1)
    )[0];

  // Unreachable: the insert either wrote the row or found one already there.
  if (subscriber === undefined) {
    throw new Error("a subscriber was neither created nor found for this opt-in");
  }

  /**
   * Every slot in turn, lowest first, letting the unique index decide.
   *
   * Reading the held slots and picking a free one would be a read-then-write on the
   * constraint that *is* the cap, so instead each attempt asks the database and a taken slot
   * simply returns nothing. Three round trips in the worst case, against a subscriber whose
   * account is full and who is about to be refused anyway.
   */
  for (let slot = 0; slot < MAX_SUBSCRIPTIONS_PER_SUBSCRIBER; slot++) {
    const [row] = await db
      .insert(subscriptions)
      .values({
        id: crypto.randomUUID(),
        subscriberId: subscriber.id,
        slot,
        criteria: pending.criteria,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [subscriptions.subscriberId, subscriptions.slot],
      })
      .returning({ slot: subscriptions.slot });

    if (row !== undefined) {
      return {
        subscriberId: subscriber.id,
        sendDay: subscriber.sendDay as SendDay,
        slot: row.slot,
      };
    }
  }

  return null;
}

/**
 * The criteria a subscriber is about to confirm, for the page the link opens.
 *
 * Read through `readCriteria()` rather than `JSON.parse`, which is not defensive
 * boilerplate: a stored value that stopped being legal when a vocabulary changed must not
 * reach the page as a checkbox nobody can act on, and the parser is the one place that rule
 * lives.
 */
export function pendingCriteria(pending: PendingOptIn): SubscriptionCriteria {
  return readCriteria(pending.criteria);
}

/**
 * Whether the configured pepper is the one the Do-Not-Contact list was written under, and the
 * bootstrap that answers the question the first time.
 *
 * ADR 0010: the pepper "must never rotate, and losing it fails open… every Do-Not-Contact
 * entry silently stops matching and the platform resumes mailing people who reported it as
 * spam, with no alarm anywhere. A fixed canary string is HMAC'd at boot and compared against
 * a stored constant so a wrong pepper fails loudly and immediately."
 *
 * **The stored constant is a row rather than a literal**, because a literal would have to be
 * committed and it is a function of the production pepper, which no committed file may know.
 * A row also makes the check the same point lookup the refusal itself is, so it costs one
 * indexed read on the signup path.
 *
 * **The bootstrap is allowed only into an empty table**, and that condition is the whole
 * strength of the check. Writing the canary whenever it is merely absent would have left the
 * failure it guards reachable in one step: delete the canary row, and the next signup writes
 * a fresh one under whatever pepper is now configured, while every real entry beside it has
 * silently stopped matching. Requiring the table to hold nothing at all closes that, because
 * a table with no entries has nothing that *can* fail open — there is no refusal to lose.
 *
 * One honest consequence remains, and it belongs in the provisioning record rather than being
 * discovered: **the pepper in place at the platform's first-ever signup becomes canonical**,
 * typo and all. That is inherent to self-bootstrapping, and `docs/provisioning-record.md` now
 * says to set the secret before that moment.
 *
 * @throws if the pepper has changed, or if entries exist with no canary beside them.
 */
export async function assertPepperUnchanged(
  db: Database,
  canary: string,
  now: Date,
): Promise<void> {
  const [stored] = await db
    .select({ digest: doNotContact.digest })
    .from(doNotContact)
    .where(eq(doNotContact.reason, "canary"))
    .limit(1);

  if (stored !== undefined) {
    if (stored.digest !== canary) {
      throw new Error(
        "DO_NOT_CONTACT_PEPPER does not match the pepper the Do-Not-Contact list was " +
          "written under. Every entry has silently stopped matching (ADR 0010). Restore " +
          "the original pepper; do not clear the canary.",
      );
    }
    return;
  }

  const [anyEntry] = await db
    .select({ digest: doNotContact.digest })
    .from(doNotContact)
    .limit(1);

  if (anyEntry !== undefined) {
    throw new Error(
      "The Do-Not-Contact list holds entries but no canary, so there is no way to tell " +
        "whether DO_NOT_CONTACT_PEPPER still matches what they were written under (ADR " +
        "0010). Restore the canary row rather than deleting the entries.",
    );
  }

  await db
    .insert(doNotContact)
    .values({ digest: canary, reason: "canary", recordedAt: now })
    // Two first-ever signups arriving together both find an empty table and both write a
    // canary. They compute the same digest, so the loser's row is the winner's row.
    .onConflictDoNothing();
}

/**
 * Put an address beyond contact.
 *
 * The `complaint` half of a table this module already writes: {@link assertPepperUnchanged}
 * inserts the `canary` row, so the question was never whether this file writes
 * `do_not_contact` but whether both reasons live together — and they should, because the
 * digest's construction and the reason vocabulary are then spelled out once.
 *
 * What *decides* to refuse an address is a Retirement, which belongs to the ticket that reads
 * Resend's complaint webhook; this is the statement it will call. The suite is its other
 * caller, and not incidentally: the identical-response rule cannot be tested without putting
 * an address on the list, and a test that hand-rolled the insert would be a second copy of
 * the schema knowledge above.
 *
 * The conflict deliberately changes nothing: an address refused twice has one entry, and the
 * date worth keeping is the earlier one.
 */
export async function refuseContact(
  db: Database,
  digest: string,
  now: Date,
): Promise<void> {
  await db
    .insert(doNotContact)
    .values({ digest, reason: "complaint", recordedAt: now })
    .onConflictDoNothing();
}
