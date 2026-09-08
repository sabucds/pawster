import { DIGEST_DAILY_BUDGET } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import { SIGN_IN_GLOBAL_DAILY_CEILING } from "../src/lib/auth/policy.ts";
import {
  MAX_SUBSCRIPTIONS_PER_SUBSCRIBER,
  OPT_IN_GLOBAL_DAILY_CEILING,
  OPT_IN_MAIL_COOLDOWN_MS,
  OPT_IN_TTL_MS,
  SIGNUP_IP_REQUEST_LIMIT,
  SUBSCRIBER_LOCALES,
  type SendDayLoad,
  assignSendDay,
  isOptInExpired,
  optInPurgeCutoff,
  parseLocale,
  refuseOptIn,
  refuseSignup,
} from "../src/lib/subscriber/policy.ts";

const AT = new Date("2026-03-04T12:00:00Z");
const DAY_MS = 24 * 60 * 60_000;

/** Seven counts, one per weekday, `0` = Sunday to match `Date.prototype.getUTCDay`. */
const loads = (...counts: number[]): SendDayLoad =>
  counts as unknown as SendDayLoad;

describe("assignSendDay", () => {
  it("picks the day with the fewest subscribers on it", () => {
    expect(assignSendDay(loads(9, 9, 9, 2, 9, 9, 9))).toBe(3);
    expect(assignSendDay(loads(9, 9, 9, 9, 9, 9, 1))).toBe(6);
  });

  it("puts the first subscriber on Sunday and then spreads one per day", () => {
    // A brand-new platform: every day is empty, so the tie-break decides, and the
    // subscribers that follow fill the remaining days before any day takes a second.
    const filling = loads(0, 0, 0, 0, 0, 0, 0);
    for (let expected = 0; expected < 7; expected++) {
      const day = assignSendDay(filling);
      expect(day).toBe(expected);
      filling[day]++;
    }
    expect(assignSendDay(filling)).toBe(0);
  });

  /**
   * A tie has to break the same way every time, or two subscribers signing up in the same
   * second could both be told a different day for the same reason. Lowest index is the
   * arbitrary half of the rule; being deterministic is the load-bearing half.
   */
  it("breaks a tie on the lowest day rather than at random", () => {
    expect(assignSendDay(loads(4, 4, 4, 4, 4, 4, 4))).toBe(0);
    expect(assignSendDay(loads(9, 3, 3, 9, 9, 9, 9))).toBe(1);
  });

  it("refuses a load table that is not one count per weekday", () => {
    expect(() => assignSendDay(loads(0, 0, 0))).toThrow(/seven/);
    expect(() => assignSendDay(loads(0, 0, 0, 0, 0, 0, 0, 0))).toThrow(/seven/);
  });
});

describe("refuseSignup", () => {
  const clean = {
    onDoNotContact: false,
    subscriptionCount: 0,
    lastOptInMailAt: null,
    optInMailsInWindow: 0,
    ipRequestsInWindow: 0,
  } as const;

  it("accepts a signup with nothing against it", () => {
    expect(refuseSignup(clean, AT)).toBeNull();
  });

  /**
   * The ticket's own words: the form "must refuse an address on the Do-Not-Contact list
   * without saying that is why". The verdict exists so the endpoint can act on it; what the
   * endpoint may *say* about it is fixed separately, and asserted against the real response
   * in `subscriber-opt-in.test.ts`.
   */
  it("refuses an address on the Do-Not-Contact list", () => {
    expect(refuseSignup({ ...clean, onDoNotContact: true }, AT)).toBe(
      "do-not-contact",
    );
  });

  it("refuses a subscriber who already holds three subscriptions", () => {
    expect(
      refuseSignup(
        { ...clean, subscriptionCount: MAX_SUBSCRIPTIONS_PER_SUBSCRIBER },
        AT,
      ),
    ).toBe("subscription-cap");
    expect(
      refuseSignup(
        { ...clean, subscriptionCount: MAX_SUBSCRIPTIONS_PER_SUBSCRIBER - 1 },
        AT,
      ),
    ).toBeNull();
  });

  it("sends at most one opt-in mail per address per day", () => {
    const mailedAt = new Date(AT.getTime() - OPT_IN_MAIL_COOLDOWN_MS + 1);
    expect(refuseSignup({ ...clean, lastOptInMailAt: mailedAt }, AT)).toBe(
      "opt-in-cooldown",
    );

    const longEnoughAgo = new Date(AT.getTime() - OPT_IN_MAIL_COOLDOWN_MS);
    expect(
      refuseSignup({ ...clean, lastOptInMailAt: longEnoughAgo }, AT),
    ).toBeNull();
  });

  it("treats never-mailed and mailed-long-ago as the same answer", () => {
    expect(refuseSignup({ ...clean, lastOptInMailAt: null }, AT)).toBeNull();
  });

  it("refuses a caller asking too often, whatever address it submits", () => {
    expect(
      refuseSignup({ ...clean, ipRequestsInWindow: SIGNUP_IP_REQUEST_LIMIT }, AT),
    ).toBe("ip-rate-limited");
    expect(
      refuseSignup(
        { ...clean, ipRequestsInWindow: SIGNUP_IP_REQUEST_LIMIT - 1 },
        AT,
      ),
    ).toBeNull();
  });

  it("refuses a signup once the platform's opt-in mail for the day is gone", () => {
    expect(
      refuseSignup(
        { ...clean, optInMailsInWindow: OPT_IN_GLOBAL_DAILY_CEILING },
        AT,
      ),
    ).toBe("global-ceiling");
  });

  /**
   * The ordering is the honesty requirement, and it is the same one ADR 0013 gives
   * `refuseMail`: `ip-rate-limited` and `global-ceiling` are the two refusals a caller may
   * be *told* about, because neither is a fact about the submitted address. The three
   * address-scoped ones must stay silent, so they are tested last — a request that trips
   * both kinds has to report the one that can be spoken aloud, or the spoken answer becomes
   * a signal about the address.
   */
  it("reports the refusals it may speak about before the ones it may not", () => {
    const both = {
      ...clean,
      onDoNotContact: true,
      subscriptionCount: MAX_SUBSCRIPTIONS_PER_SUBSCRIBER,
      lastOptInMailAt: AT,
      optInMailsInWindow: OPT_IN_GLOBAL_DAILY_CEILING,
      ipRequestsInWindow: SIGNUP_IP_REQUEST_LIMIT,
    };
    expect(refuseSignup(both, AT)).toBe("ip-rate-limited");
    expect(refuseSignup({ ...both, ipRequestsInWindow: 0 }, AT)).toBe(
      "global-ceiling",
    );
  });

  it("never eats into the digest's allocation, alongside sign-in mail", () => {
    /**
     * The cross-package assertion `auth-policy.test.ts` makes for sign-in, extended to the
     * second claimant on the same reservation. `DIGEST_DAILY_BUDGET` holds 30 of Resend's
     * 100 back for shelter codes, opt-in mail and confirmation nudges; those three figures
     * live in three files that do not import each other, so nothing but this notices when
     * one of them grows past the reservation they share.
     */
    const reserved = 100 - DIGEST_DAILY_BUDGET;
    expect(SIGN_IN_GLOBAL_DAILY_CEILING + OPT_IN_GLOBAL_DAILY_CEILING).toBeLessThan(
      reserved,
    );
  });
});

describe("refuseOptIn", () => {
  it("accepts a link inside its life", () => {
    expect(refuseOptIn({ createdAt: new Date(AT.getTime() - DAY_MS) }, AT)).toBeNull();
  });

  /**
   * The link's lifetime and the purge's are **the same constant**, which is the design: the
   * row is what the link names, so a link that has outlived its row is a link that finds
   * nothing anyway. Two constants would have been two facts that can disagree about the
   * same moment — the mistake `db/`'s `upload_sessions` comment names about a `createdAt`
   * plus an `expiresAt`.
   */
  it("refuses a link older than the row it names is allowed to live", () => {
    const born = new Date(AT.getTime() - OPT_IN_TTL_MS);
    expect(refuseOptIn({ createdAt: born }, AT)).toBe("expired");

    const justInside = new Date(AT.getTime() - OPT_IN_TTL_MS + 1);
    expect(refuseOptIn({ createdAt: justInside }, AT)).toBeNull();
  });

  it("expires exactly when the purge would have taken the row", () => {
    const born = new Date(AT.getTime() - OPT_IN_TTL_MS);
    expect(isOptInExpired(born, AT)).toBe(true);
    expect(born.getTime()).toBeLessThanOrEqual(optInPurgeCutoff(AT).getTime());
  });

  it("purges seven days back and no further", () => {
    expect(AT.getTime() - optInPurgeCutoff(AT).getTime()).toBe(7 * DAY_MS);
  });
});

describe("parseLocale", () => {
  /**
   * ADR 0018: the digest email "is the only surface whose locale is a stored per-subscriber
   * fact rather than a property of the URL, so the subscriber's locale is captured at
   * opt-in". This is that capture, and its default is es-VE because ADR 0007 makes Spanish
   * the default locale and English the translation.
   */
  it("keeps a locale the platform has strings for", () => {
    for (const locale of SUBSCRIBER_LOCALES) {
      expect(parseLocale(locale)).toBe(locale);
    }
  });

  it("falls back to the default locale for anything else", () => {
    expect(parseLocale("fr")).toBe("es");
    expect(parseLocale(null)).toBe("es");
    expect(parseLocale("")).toBe("es");
    expect(parseLocale("ES")).toBe("es");
  });
});
