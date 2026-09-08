/**
 * The numbers and verdicts of shelter access, with no I/O and no clock of its own.
 *
 * Every function here takes `now` as an argument, the same posture `domain/` takes, so no
 * test in this file waits for or fakes a clock. It lives in `web/` rather than `domain/`
 * because it has exactly one consumer: `domain/` is "the pure rules three consumers share
 * — the prerender, the browser island and the digest matcher", and none of those three
 * signs a shelter in. The purity is worth having anyway, because it is what lets the
 * five-attempt ceiling and the mail allocation be table tests rather than integration
 * tests with a mail server in them.
 *
 * Every figure below is [ADR 0013](../../../../docs/adr/0013-shelters-sign-in-with-an-emailed-code.md)'s.
 */

/** Six digits (ADR 0013). Short enough to read off a shared phone and retype. */
export const ONE_TIME_CODE_DIGITS = 6;

/**
 * The number of distinct codes, and the denominator the attempt ceiling is judged against:
 * five guesses out of a million is roughly 1 in 200,000, and a sixth guess costs the
 * attacker a fresh code they cannot read.
 */
export const ONE_TIME_CODE_SPACE = 10 ** ONE_TIME_CODE_DIGITS;

/** Ten minutes. Long enough for mail to arrive, short enough that a forwarded code rots. */
export const ONE_TIME_CODE_TTL_MS = 10 * 60_000;

/** Five wrong guesses and the code dies — not the session, not the shelter, the code. */
export const ONE_TIME_CODE_MAX_ATTEMPTS = 5;

/**
 * Ninety days, sliding.
 *
 * Long on purpose, and the reasoning is about mail rather than about risk. ADR 0008 already
 * removed the high-frequency reason to sign in: Confirmation, the monthly act the listing's
 * honesty depends on, needs no session at all. A session is only needed to publish, change
 * photos or edit contact points, which is rare — so a short session buys little and spends
 * the scarce resource. At 90 days roughly 40 shelters generate about 0.4 sign-ins a day,
 * where 7 days would cost fifteen times the mail for no gain in the common case.
 */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;

/**
 * How stale a cookie may get before a request re-issues it.
 *
 * The refresh writes nothing to the database — it re-signs the same three facts with a new
 * issued-at — so its only cost is a `Set-Cookie` header, and this threshold exists to keep
 * that off every single response rather than to protect anything. A day means a shelter
 * that visits at all keeps its session indefinitely, and one that vanishes for ninety days
 * loses it.
 *
 * It must stay well under {@link SESSION_TTL_MS}: a threshold anywhere near the lifetime
 * would let a cookie expire between two refreshes that both declined to act.
 */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60_000;

/**
 * The global ceiling on sign-in mail: about 20 sends a day.
 *
 * Sign-in has priority over the digest — a late digest is a non-event, a shelter that
 * cannot sign in is locked out and cannot publish at all — but a **bounded** priority. The
 * code-request form is unauthenticated by necessity, because ADR 0008 requires it to answer
 * identically whether or not an address is registered; with unbounded priority anyone could
 * exhaust the digest's share of Resend's 100/day just by asking for codes.
 *
 * Twenty is far above the 0.4 expected and bounds any attack to a fifth of the quota. It
 * sits inside the 30 emails `domain/`'s `DIGEST_DAILY_BUDGET` holds back from the digest,
 * and `policy.test.ts` asserts that rather than trusting the two files to agree.
 */
export const SIGN_IN_GLOBAL_DAILY_CEILING = 20;

/** One code per address per five minutes. */
export const SIGN_IN_ADDRESS_COOLDOWN_MS = 5 * 60_000;

/**
 * The per-address daily cap. Five is generous against 0.4 expected sign-ins a day for the
 * whole platform, and it is the limit that stops one address from spending the global
 * ceiling on its own — without it, 20 sends could all belong to one inbox and every other
 * shelter would be locked out by a single noisy one.
 */
export const SIGN_IN_ADDRESS_DAILY_CAP = 5;

/** The window the per-IP request limit is counted over. */
export const SIGN_IN_IP_WINDOW_MS = 60 * 60_000;

/**
 * Requests one IP may make per {@link SIGN_IN_IP_WINDOW_MS}, counted whether or not they
 * cost mail.
 *
 * This is the only limit that counts *requests* rather than *sends*, and it has to: the
 * other three are keyed on the shelter an address resolved to, so a caller submitting
 * addresses that resolve to nobody is invisible to all of them. That caller spends no mail,
 * but it does spend a database write per request, and this is what bounds it.
 */
export const SIGN_IN_IP_REQUEST_LIMIT = 10;

/**
 * Why a code row cannot be used, or `null` when it can.
 *
 * Deliberately not folded into the hash comparison. Whether the submitted digits are right
 * is an async keyed-HMAC question; whether the row is still alive is arithmetic over two
 * columns, and separating them is what makes the ceiling and the expiry testable without a
 * secret.
 */
export type OneTimeCodeRefusal = "expired" | "attempts-exhausted";

export interface OneTimeCodeState {
  readonly expiresAt: Date;
  readonly attemptsUsed: number;
}

/**
 * Whether an outstanding code may still be checked against.
 *
 * Expiry is tested before attempts so that a code which ran out of time *and* attempts
 * reports the honest reason a shelter can act on: request another one.
 */
export function refuseOneTimeCode(
  state: OneTimeCodeState,
  now: Date,
): OneTimeCodeRefusal | null {
  if (now.getTime() >= state.expiresAt.getTime()) return "expired";
  if (state.attemptsUsed >= ONE_TIME_CODE_MAX_ATTEMPTS) {
    return "attempts-exhausted";
  }
  return null;
}

/**
 * Whether a wrong guess has just killed the code. Called with the count *after* the
 * increment, so the fifth wrong guess is the one that retires it.
 */
export function isCodeExhausted(attemptsUsed: number): boolean {
  return attemptsUsed >= ONE_TIME_CODE_MAX_ATTEMPTS;
}

/** The three facts a Session cookie carries, and the only three (ADR 0013). */
export interface SessionClaims {
  readonly shelterId: string;
  readonly issuedAt: Date;
  /** The `shelters.sessionEpoch` this cookie was minted under. */
  readonly epoch: number;
}

/**
 * Why a cookie is not a session, or `null` when it is.
 *
 * `superseded` is the revocation path: the shelter row's epoch has moved past the one this
 * cookie was minted under, which is what bumping a single integer does to every live cookie
 * at once.
 */
export type SessionRefusal = "expired" | "superseded";

export function refuseSession(
  claims: SessionClaims,
  currentEpoch: number,
  now: Date,
): SessionRefusal | null {
  if (claims.epoch !== currentEpoch) return "superseded";
  if (now.getTime() - claims.issuedAt.getTime() >= SESSION_TTL_MS) {
    return "expired";
  }
  return null;
}

/**
 * Whether this request should re-issue the cookie. A `true` here costs one `Set-Cookie` and
 * **no database write** — the whole point of validating against a column the request was
 * going to read anyway.
 */
export function shouldRefreshSession(claims: SessionClaims, now: Date): boolean {
  return now.getTime() - claims.issuedAt.getTime() >= SESSION_REFRESH_AFTER_MS;
}

/**
 * What the mail ledger says about one code request. Counted from the ledger rather than
 * from four running totals, so no counter can disagree with the history it summarises.
 */
export interface MailBudgetUsage {
  /** Sends across the whole platform inside the trailing day. */
  readonly globalSendsInWindow: number;
  /** Sends to *this* shelter inside the trailing day. */
  readonly addressSendsInWindow: number;
  /**
   * When this shelter was last sent a code, or `null` if never. `null` and "long ago" are
   * the same answer to the cooldown and are deliberately not distinguished.
   */
  readonly lastAddressSendAt: Date | null;
}

/**
 * Why this request may not spend an email, or `null` when it may.
 *
 * `global-ceiling` is the one a shelter is told about honestly — "try tomorrow" — because
 * it is the only refusal that is not about anything the shelter did. The other two are
 * silent: telling a caller it is inside a per-address cooldown confirms the address exists,
 * which is the enumeration oracle ADR 0008 forbids.
 */
export type MailRefusal = "global-ceiling" | "address-cooldown" | "address-daily-cap";

/**
 * The allocation decision, and note the order: the global ceiling is tested **first**.
 *
 * That ordering is the honesty requirement. A request that is both over the global ceiling
 * and inside a per-address cooldown has to report the ceiling, because the ceiling is what
 * the shelter can be told about and act on, and the cooldown is what must stay silent.
 * Testing the cheap per-address checks first would have hidden the platform-wide state
 * behind a per-address one.
 */
export function refuseMail(
  usage: MailBudgetUsage,
  now: Date,
): MailRefusal | null {
  if (usage.globalSendsInWindow >= SIGN_IN_GLOBAL_DAILY_CEILING) {
    return "global-ceiling";
  }
  if (usage.addressSendsInWindow >= SIGN_IN_ADDRESS_DAILY_CAP) {
    return "address-daily-cap";
  }
  if (
    usage.lastAddressSendAt !== null &&
    now.getTime() - usage.lastAddressSendAt.getTime() <
      SIGN_IN_ADDRESS_COOLDOWN_MS
  ) {
    return "address-cooldown";
  }
  return null;
}

/** The trailing-day window every send-scoped limit is counted over. */
export const MAIL_BUDGET_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A rolling 24 hours rather than a calendar day, and the difference matters.
 *
 * A UTC calendar day resets at a known instant, which hands an attacker two full
 * allocations back to back across the boundary — and resets at 00:00 UTC, which is 20:00 in
 * Venezuela, in the middle of the evening rather than at a quiet hour. A trailing window has
 * no boundary to sit on. The cost is that "try tomorrow" is approximate: the honest reading
 * is "in a few hours", and the copy says so.
 */
export function mailBudgetWindowStart(now: Date): Date {
  return new Date(now.getTime() - MAIL_BUDGET_WINDOW_MS);
}

export function ipWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGN_IN_IP_WINDOW_MS);
}
