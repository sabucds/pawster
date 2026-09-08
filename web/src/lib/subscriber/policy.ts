/**
 * The numbers and verdicts of subscriber opt-in, with no I/O and no clock of its own.
 *
 * The same posture as [`../auth/policy.ts`](../auth/policy.ts), and for the same reason: the
 * figures below decide who gets mail and who is refused, and every one of them is worth a
 * table test rather than an integration test with a mail server in it. Every function takes
 * `now` as an argument, so nothing here waits for or fakes a clock.
 *
 * It lives in `web/` rather than `domain/` because `domain/` is "the pure rules three
 * consumers share — the prerender, the browser island and the digest matcher", and none of
 * those three signs anybody up. The one figure that *is* shared, the mail budget, is
 * imported from there rather than restated.
 *
 * Retention, the HMAC'd Do-Not-Contact entry and the rule that an IP may live on the
 * unconfirmed row and nowhere else are all
 * [ADR 0010](../../../../docs/adr/0010-subscriber-data-retention.md)'s.
 */

/**
 * The most subscriptions one address may hold, and a **second** line of defence only.
 *
 * The database refuses a fourth row itself — `subscriptions.slot` is 0–2 with a unique index
 * on `(subscriber_id, slot)` — because a count read here and acted on a moment later is a
 * race. What this constant buys is the *early* refusal: without it the platform spends an
 * opt-in email on a subscription that would be rejected at the end of it.
 */
export const MAX_SUBSCRIPTIONS_PER_SUBSCRIBER = 3;

/**
 * Seven days, and **one constant serves both** the opt-in link's lifetime and the purge
 * cutoff that destroys the row the link names.
 *
 * That is the design rather than a convenience. The row *is* what the link names, so a link
 * outliving its row is a link that finds nothing anyway; deriving
 * {@link optInPurgeCutoff} from the same figure makes "the link stops working exactly when
 * the row is due for destruction" true by construction. Two constants would have been two
 * facts that can disagree about a single moment — the mistake `db/`'s `upload_sessions`
 * comment already names about carrying a `createdAt` and an `expiresAt` side by side.
 */
export const OPT_IN_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * At most one opt-in mail per address per 24 hours (ADR 0010).
 *
 * Refused **silently**. Telling a caller it is inside a cooldown reveals that somebody asked
 * about that address recently, which is a fact about the address and therefore exactly the
 * oracle the identical-response rule exists to close.
 */
export const OPT_IN_MAIL_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * The global ceiling on opt-in mail: six sends a day.
 *
 * Resend's free tier is 100/day. `DIGEST_DAILY_BUDGET` holds 70 of those for the digest
 * itself, ADR 0013 spends 20 of the remaining 30 on shelter sign-in, and #60's confirmation
 * nudges need about 4 — which leaves six, and this is them. `subscriber-policy.test.ts`
 * asserts the sum against `DIGEST_DAILY_BUDGET` rather than trusting three files that do not
 * import each other to agree about one reservation.
 *
 * Six is a real limit on how fast the subscriber base can grow, not a comfortable headroom:
 * a shelter posting the signup link to Instagram can beat it in an evening, and the seventh
 * person that day is refused. It is **spoken about honestly** for that reason — the refusal
 * is not a fact about the caller's address, and a person told "try again tomorrow" can act
 * on it. Lending the digest's idle slack is the obvious fix and belongs to #63, which owns
 * scheduling; a run only mails the subscribers whose send day it is, so at 100 subscribers
 * roughly 14 of the reserved 70 are actually spent.
 */
export const OPT_IN_GLOBAL_DAILY_CEILING = 6;

/** The window the per-IP request limit is counted over. */
export const SIGNUP_IP_WINDOW_MS = 60 * 60_000;

/**
 * Signups one IP may have outstanding per {@link SIGNUP_IP_WINDOW_MS}.
 *
 * Twenty rather than sign-in's ten because the shapes differ. A shelter signs itself in; a
 * subscriber signup is a public form, and two people in a household, or a volunteer walking
 * several visitors through it on shared wifi, are ordinary use that must not read as an
 * attack.
 *
 * **Counted over unconfirmed opt-in rows, which means it counts sends and not requests**, and
 * the difference is forced rather than chosen. ADR 0013's version of this limit counts every
 * request, sent or refused, over the sign-in ledger — but that ledger holds an IP, and ADR
 * 0010 allows the subscriber model exactly one table that does. A second ledger keyed on the
 * caller would be a second such table, so the count is taken over `pending_opt_ins`
 * (`web/src/lib/subscriber/store.ts`).
 *
 * What that costs, stated rather than glossed: a caller submitting addresses that are all
 * inside a cooldown, all already at the cap, or all on the Do-Not-Contact list writes no row
 * and so is invisible to this limit. What it does *not* cost is the thing the limit exists
 * for — every one of those requests is silently refused, spends no mail and writes nothing,
 * so a caller that wants twenty rows in an hour still needs twenty addresses it has not used
 * today, which is the mailbomb this refuses. The unbounded residue is reads.
 */
export const SIGNUP_IP_REQUEST_LIMIT = 20;

/**
 * The locales the platform has strings for, and therefore the only ones a subscriber's
 * record may hold. Mirrors `astro.config.mjs`'s `locales`.
 */
export const SUBSCRIBER_LOCALES = ["es", "en"] as const;

export type SubscriberLocale = (typeof SUBSCRIBER_LOCALES)[number];

/** es-VE, because ADR 0007 makes Spanish the default and English the translation. */
export const DEFAULT_SUBSCRIBER_LOCALE: SubscriberLocale = "es";

/**
 * The locale to store for a subscriber, given whatever the signup form submitted.
 *
 * [ADR 0018](../../../../docs/adr/0018-strings-are-typed-phrase-functions.md) makes the
 * digest email "the only surface whose locale is a stored per-subscriber fact rather than a
 * property of the URL, so the subscriber's locale is captured at opt-in". This is that
 * capture.
 *
 * Exact match only, and it **falls back rather than refusing**. Both halves follow from what
 * this input is: a hidden field the platform's own prerendered pages set from the route the
 * subscriber was already reading, not an `Accept-Language` header to negotiate. A value
 * outside the list means the form was hand-edited or the page is stale, neither of which is
 * worth failing a signup over, and neither of which deserves the guesswork that
 * case-folding or tag-prefix matching would imply.
 */
export function parseLocale(value: string | null | undefined): SubscriberLocale {
  return SUBSCRIBER_LOCALES.includes(value as SubscriberLocale)
    ? (value as SubscriberLocale)
    : DEFAULT_SUBSCRIBER_LOCALE;
}

/** A weekday, `0` = Sunday, matching `Date.prototype.getUTCDay`. */
export type SendDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The seven weekdays as data beside their type, the shape `domain/src/axes.ts` uses for its
 * own vocabularies.
 *
 * It earns its place here rather than being a bare `for` bound: iterating these gives the
 * loop in {@link assignSendDay} a {@link SendDay}-typed index, which is what lets a tuple
 * read be known-present instead of `number | undefined`.
 */
export const SEND_DAYS: readonly SendDay[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * How many subscribers sit on each weekday: seven counts, one per day, indexed as
 * {@link SendDay}.
 *
 * A tuple rather than `number[]` so that a caller which read six days out of the database,
 * or grouped by day and got only the days that had rows, cannot pass the result in. The
 * runtime check in {@link assignSendDay} exists because a `GROUP BY` result reaches this
 * module as `number[]` and one cast is all it takes to lose the guarantee.
 */
export type SendDayLoad = [number, number, number, number, number, number, number];

/**
 * The weekday a new subscriber's digest should go out on: the least-loaded day, ties broken
 * on the lowest index.
 *
 * Least-loaded rather than a round-robin counter because the balance then **repairs itself**
 * after erasures. ADR 0010 makes erasure ordinary rather than exceptional, so days develop
 * holes: a Tuesday emptied by five unsubscribes is the next five subscribers' day here,
 * where a counter would keep handing out days in rotation and the population would stay
 * lopsided for as long as it took the counter to come round.
 *
 * The tie-break is deterministic on purpose. Which day wins a tie is arbitrary — lowest
 * index is as good as any — but *being deterministic* is load-bearing: two subscribers
 * signing up in the same second must not be told different days for the same reason, or the
 * assignment stops being reproducible from the load table it was derived from.
 */
export function assignSendDay(load: Readonly<SendDayLoad>): SendDay {
  if (load.length !== 7) {
    throw new Error(
      `A send-day load table must hold seven counts, one per weekday; got ${load.length}.`,
    );
  }
  let leastLoaded: SendDay = 0;
  let fewest = load[0];
  for (const day of SEND_DAYS) {
    if (load[day] < fewest) {
      fewest = load[day];
      leastLoaded = day;
    }
  }
  return leastLoaded;
}

/**
 * Why a signup may not proceed, or `null` when it may.
 *
 * Five reasons, and they divide into two kinds — see {@link SPEAKABLE_REFUSALS}, which is the
 * division as data.
 */
export type SignupRefusal =
  | "ip-rate-limited"
  | "global-ceiling"
  | "do-not-contact"
  | "subscription-cap"
  | "opt-in-cooldown";

/**
 * The refusals a caller may be **told about**, as data rather than as a condition somewhere.
 *
 * Neither of these is a fact about the submitted address — one is about the caller's request
 * rate, the other about the platform's own quota — so saying either out loud reveals nothing
 * about who is or is not subscribed. The other three are address-scoped and must stay
 * silent behind the identical "check your inbox" response.
 *
 * Exported as a list so the endpoint asks it instead of restating the split in an `if`. That
 * also fixes the direction the code fails in: a refusal added to {@link SignupRefusal} later
 * is silent until somebody names it here, and silence is the safe default.
 */
export const SPEAKABLE_REFUSALS: readonly SignupRefusal[] = [
  "ip-rate-limited",
  "global-ceiling",
];

export function isSpeakable(refusal: SignupRefusal): boolean {
  return SPEAKABLE_REFUSALS.includes(refusal);
}

/** Everything the signup decision needs, assembled by `store.ts` in one query pass. */
export interface SignupState {
  /** Whether this address's HMAC is on the Do-Not-Contact list (ADR 0010). */
  readonly onDoNotContact: boolean;
  /** Confirmed subscriptions this address already holds. */
  readonly subscriptionCount: number;
  /**
   * When this address was last sent an opt-in mail, or `null` if never. `null` and "long
   * ago" are the same answer to the cooldown and are deliberately not distinguished.
   */
  readonly lastOptInMailAt: Date | null;
  /** Opt-in mails sent across the whole platform inside the trailing day. */
  readonly optInMailsInWindow: number;
  /**
   * Unconfirmed opt-ins this IP has created inside {@link SIGNUP_IP_WINDOW_MS} — see
   * {@link SIGNUP_IP_REQUEST_LIMIT} for why this counts sends rather than requests.
   */
  readonly ipRequestsInWindow: number;
}

/**
 * The signup decision, and **the order of the checks is part of the specification**.
 *
 * The two speakable refusals are tested first, for the reason ADR 0013 gives `refuseMail`: a
 * request that trips both a speakable limit and a silent one has to report the speakable
 * one. Test the cheap address-scoped checks first and the mere *presence* of a spoken answer
 * becomes a signal about the address — the caller learns "this address is on a list or at its
 * cap" from the fact that it was not told "try tomorrow".
 *
 * Within the silent three the order is unobservable by design, since all three produce the
 * identical response; they are ordered cheapest-fact-first for readability only.
 */
export function refuseSignup(state: SignupState, now: Date): SignupRefusal | null {
  if (state.ipRequestsInWindow >= SIGNUP_IP_REQUEST_LIMIT) {
    return "ip-rate-limited";
  }
  if (state.optInMailsInWindow >= OPT_IN_GLOBAL_DAILY_CEILING) {
    return "global-ceiling";
  }
  if (state.onDoNotContact) return "do-not-contact";
  if (state.subscriptionCount >= MAX_SUBSCRIPTIONS_PER_SUBSCRIBER) {
    return "subscription-cap";
  }
  if (
    state.lastOptInMailAt !== null &&
    now.getTime() - state.lastOptInMailAt.getTime() < OPT_IN_MAIL_COOLDOWN_MS
  ) {
    return "opt-in-cooldown";
  }
  return null;
}

/**
 * The trailing-day window the global opt-in ceiling is counted over.
 *
 * A rolling 24 hours rather than a calendar day, matching sign-in: a fixed reset hands an
 * attacker two full allocations back to back across the boundary, and 00:00 UTC is 20:00 in
 * Venezuela — the middle of the evening rather than a quiet hour.
 */
export const OPT_IN_WINDOW_MS = 24 * 60 * 60_000;

export function optInWindowStart(now: Date): Date {
  return new Date(now.getTime() - OPT_IN_WINDOW_MS);
}

export function signupIpWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNUP_IP_WINDOW_MS);
}

/** What redeeming an opt-in link turns on — see {@link OPT_IN_TTL_MS} and {@link refuseOptIn}. */
export interface PendingOptInFacts {
  /**
   * When the row was written, which is also when the mail was sent: the row exists only
   * because a mail was sent, so one timestamp is the link's clock *and* the address's
   * rate-limit ledger. That is what keeps the IP off every other table.
   */
  readonly createdAt: Date;
  /**
   * Subscriptions the address already holds, read at the moment the link is followed and not
   * when it was sent.
   *
   * Read again rather than carried, because up to seven days pass in between and the answer
   * moves: a subscriber holding two searches who signs up twice more gets two links, and
   * whichever is followed second finds a full account. {@link refuseSignup} checked the same
   * fact at signup and could not have known this.
   */
  readonly subscriptionCount: number;
}

/**
 * Why an opt-in link cannot be redeemed, or `null` when it can.
 *
 * Two members, and **"already used" is not one of them**: single-use is enforced by the row's
 * absence, since redemption deletes it, so a spent link finds nothing and never reaches this
 * function. That is also why the two it does have both need a page of their own — a
 * subscriber who followed a dead link and one who followed a live link into a full account
 * are owed different sentences.
 */
export type OptInRefusal = "expired" | "subscription-cap";

/**
 * The redemption decision.
 *
 * Expiry first, because a link that has run out is not a fact about the account behind it: a
 * subscriber whose link died at seven days should be told to sign up again, and telling them
 * their account is full instead sends them to a manage page to delete a search they did not
 * need to lose.
 *
 * The cap check here is the **early** refusal, exactly as
 * {@link MAX_SUBSCRIPTIONS_PER_SUBSCRIBER} is at signup. The enforcer is still the unique
 * index on `(subscriber_id, slot)`, which is what makes two links redeemed in the same second
 * safe; this is what keeps that from surfacing as a failed insert in the ordinary case.
 */
export function refuseOptIn(
  facts: PendingOptInFacts,
  now: Date,
): OptInRefusal | null {
  if (isOptInExpired(facts.createdAt, now)) return "expired";
  if (facts.subscriptionCount >= MAX_SUBSCRIPTIONS_PER_SUBSCRIBER) {
    return "subscription-cap";
  }
  return null;
}

export function isOptInExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= OPT_IN_TTL_MS;
}

/**
 * The instant before which pending opt-in rows are due for destruction; anything created at
 * or before it is gone.
 *
 * Derived from {@link OPT_IN_TTL_MS}, which is the point: this is the same fact as the link's
 * expiry, read from the other end. #66 owns running it on a schedule — this supplies the
 * cutoff and nothing else.
 */
export function optInPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - OPT_IN_TTL_MS);
}
