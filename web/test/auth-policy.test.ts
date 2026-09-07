import { DIGEST_DAILY_BUDGET } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import {
  MAIL_BUDGET_WINDOW_MS,
  ONE_TIME_CODE_DIGITS,
  ONE_TIME_CODE_MAX_ATTEMPTS,
  ONE_TIME_CODE_SPACE,
  ONE_TIME_CODE_TTL_MS,
  SESSION_REFRESH_AFTER_MS,
  SESSION_TTL_MS,
  SIGN_IN_ADDRESS_COOLDOWN_MS,
  SIGN_IN_ADDRESS_DAILY_CAP,
  SIGN_IN_GLOBAL_DAILY_CEILING,
  isCodeExhausted,
  refuseMail,
  refuseOneTimeCode,
  refuseSession,
  shouldRefreshSession,
} from "../src/lib/auth/policy.ts";
import type { MailBudgetUsage, SessionClaims } from "../src/lib/auth/policy.ts";

/**
 * The arithmetic half of shelter access, tested without a database, a clock or a mail
 * server. Everything here takes `now` as an argument — the same posture `domain/` takes —
 * so no test in this file waits for or fakes time.
 */

const AT = new Date("2026-09-07T12:00:00Z");
const at = (offsetMs: number) => new Date(AT.getTime() + offsetMs);

describe("the shape of a One-Time Code", () => {
  it("is six digits, expiring in ten minutes, with five attempts (ADR 0013)", () => {
    expect(ONE_TIME_CODE_DIGITS).toBe(6);
    expect(ONE_TIME_CODE_TTL_MS).toBe(10 * 60_000);
    expect(ONE_TIME_CODE_MAX_ATTEMPTS).toBe(5);
    expect(ONE_TIME_CODE_SPACE).toBe(1_000_000);
  });
});

describe("whether an outstanding code may still be checked", () => {
  const usable = { expiresAt: at(ONE_TIME_CODE_TTL_MS), attemptsUsed: 0 };

  it("allows a fresh code", () => {
    expect(refuseOneTimeCode(usable, AT)).toBeNull();
  });

  it("allows the code one millisecond before it expires", () => {
    expect(refuseOneTimeCode(usable, at(ONE_TIME_CODE_TTL_MS - 1))).toBeNull();
  });

  it("expires it exactly at the ten-minute mark, not a moment after", () => {
    // The boundary is `>=`, so the instant the expiry names is already too late. Asserted
    // because an off-by-one here is a code that lives for ten minutes plus one request.
    expect(refuseOneTimeCode(usable, at(ONE_TIME_CODE_TTL_MS))).toBe("expired");
  });

  it("allows the fifth attempt and refuses the sixth", () => {
    // Four wrong guesses so far means the fifth is still owed.
    expect(refuseOneTimeCode({ ...usable, attemptsUsed: 4 }, AT)).toBeNull();
    expect(refuseOneTimeCode({ ...usable, attemptsUsed: 5 }, AT)).toBe(
      "attempts-exhausted",
    );
  });

  it("reports expiry ahead of exhaustion for a code that is both", () => {
    // The shelter's next move is the same either way — ask for another — but "expired" is
    // the reason it can act on, so it is the one reported.
    const dead = { expiresAt: at(-1), attemptsUsed: 5 };
    expect(refuseOneTimeCode(dead, AT)).toBe("expired");
  });

  it("counts the fifth wrong guess as the one that kills the code", () => {
    expect(isCodeExhausted(4)).toBe(false);
    expect(isCodeExhausted(5)).toBe(true);
  });
});

describe("whether a cookie is still a session", () => {
  const claims: SessionClaims = {
    shelterId: "shelter-1",
    issuedAt: AT,
    epoch: 3,
  };

  it("accepts a fresh cookie under the current epoch", () => {
    expect(refuseSession(claims, 3, AT)).toBeNull();
  });

  it("accepts one just inside ninety days", () => {
    expect(refuseSession(claims, 3, at(SESSION_TTL_MS - 1))).toBeNull();
  });

  it("expires it at ninety days", () => {
    expect(refuseSession(claims, 3, at(SESSION_TTL_MS))).toBe("expired");
  });

  it("refuses a cookie minted under a superseded epoch", () => {
    // The whole revocation mechanism: one integer moves and every live cookie dies.
    expect(refuseSession(claims, 4, AT)).toBe("superseded");
  });

  it("refuses a cookie whose epoch is ahead of the row's, not just behind", () => {
    // Tested for equality rather than `<`, so a cookie carrying a *higher* epoch — a forged
    // one, or a replay after a database restore — is refused too. A `claims.epoch <
    // currentEpoch` check would have accepted it.
    expect(refuseSession({ ...claims, epoch: 9 }, 3, AT)).toBe("superseded");
  });

  it("reports supersession ahead of expiry, so revocation is never reported as a lapse", () => {
    expect(refuseSession(claims, 4, at(SESSION_TTL_MS * 2))).toBe("superseded");
  });
});

describe("the sliding refresh", () => {
  const claims: SessionClaims = {
    shelterId: "shelter-1",
    issuedAt: AT,
    epoch: 0,
  };

  it("leaves a cookie younger than a day alone", () => {
    expect(shouldRefreshSession(claims, at(SESSION_REFRESH_AFTER_MS - 1))).toBe(
      false,
    );
  });

  it("re-issues one that has aged past a day", () => {
    expect(shouldRefreshSession(claims, at(SESSION_REFRESH_AFTER_MS))).toBe(true);
  });

  it("refreshes far sooner than it expires, so a session cannot lapse between refreshes", () => {
    // The load-bearing relationship between the two constants rather than either value: a
    // refresh threshold anywhere near the lifetime would let a cookie expire between two
    // requests that both declined to refresh it.
    expect(SESSION_REFRESH_AFTER_MS * 10).toBeLessThan(SESSION_TTL_MS);
  });

  it("is ninety days, which is what the mail arithmetic assumed", () => {
    expect(SESSION_TTL_MS).toBe(90 * 24 * 60 * 60_000);
  });
});

describe("the sign-in mail allocation", () => {
  const spare: MailBudgetUsage = {
    globalSendsInWindow: 0,
    addressSendsInWindow: 0,
    lastAddressSendAt: null,
  };

  it("sends when nothing has been spent", () => {
    expect(refuseMail(spare, AT)).toBeNull();
  });

  it("sends on the last unit of the global ceiling and refuses the next", () => {
    expect(
      refuseMail(
        { ...spare, globalSendsInWindow: SIGN_IN_GLOBAL_DAILY_CEILING - 1 },
        AT,
      ),
    ).toBeNull();
    expect(
      refuseMail(
        { ...spare, globalSendsInWindow: SIGN_IN_GLOBAL_DAILY_CEILING },
        AT,
      ),
    ).toBe("global-ceiling");
  });

  it("refuses an address that has spent its daily cap", () => {
    expect(
      refuseMail(
        { ...spare, addressSendsInWindow: SIGN_IN_ADDRESS_DAILY_CAP },
        AT,
      ),
    ).toBe("address-daily-cap");
  });

  it("refuses a second code inside five minutes and allows one after", () => {
    const justSent = { ...spare, lastAddressSendAt: AT };
    expect(refuseMail(justSent, at(SIGN_IN_ADDRESS_COOLDOWN_MS - 1))).toBe(
      "address-cooldown",
    );
    expect(refuseMail(justSent, at(SIGN_IN_ADDRESS_COOLDOWN_MS))).toBeNull();
  });

  it("reports the global ceiling ahead of any per-address refusal", () => {
    /**
     * The ordering assertion, and the reason `refuseMail` tests the ceiling first. A request
     * that is over the ceiling *and* inside a cooldown must report the ceiling: the ceiling
     * is the only refusal a shelter is told about, because it is the only one that is not a
     * fact about the address. Reporting the cooldown instead would both hide platform state
     * and confirm that the address exists.
     */
    expect(
      refuseMail(
        {
          globalSendsInWindow: SIGN_IN_GLOBAL_DAILY_CEILING,
          addressSendsInWindow: SIGN_IN_ADDRESS_DAILY_CAP,
          lastAddressSendAt: AT,
        },
        AT,
      ),
    ).toBe("global-ceiling");
  });

  it("never eats into the digest's allocation", () => {
    /**
     * The cross-package assertion, and the one worth having most.
     *
     * `domain/`'s `DIGEST_DAILY_BUDGET` is `100 - 30`: it holds 30 of Resend's 100 daily
     * emails back for shelter codes, opt-in mail and confirmation nudges. Sign-in's global
     * ceiling has to fit inside that reservation, or ADR 0013's "never eat the digest" is a
     * sentence rather than a property. Two files in two packages have to agree on this and
     * neither imports the other's number, so nothing but this test notices if one moves.
     */
    const reservedForNonDigestMail = 100 - DIGEST_DAILY_BUDGET;
    expect(reservedForNonDigestMail).toBe(30);
    expect(SIGN_IN_GLOBAL_DAILY_CEILING).toBeLessThanOrEqual(
      reservedForNonDigestMail,
    );

    // And it leaves room for the other two claimants on that reservation, which are opt-in
    // mail (#61) and confirmation nudges (#60) — a ceiling of 30 would have starved both
    // while still passing the check above.
    expect(SIGN_IN_GLOBAL_DAILY_CEILING).toBeLessThan(reservedForNonDigestMail);
  });

  it("bounds one address to a fraction of the global ceiling", () => {
    // Without this relationship, one noisy inbox could spend the whole platform's daily
    // allowance and lock every other shelter out.
    expect(SIGN_IN_ADDRESS_DAILY_CAP).toBeLessThan(
      SIGN_IN_GLOBAL_DAILY_CEILING / 2,
    );
  });

  it("counts the budget over a trailing day rather than a calendar one", () => {
    expect(MAIL_BUDGET_WINDOW_MS).toBe(24 * 60 * 60_000);
  });
});
