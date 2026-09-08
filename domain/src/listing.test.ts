import { describe, expect, it } from "vitest";
import { type AnimalFacts, type ShelterFacts, isListed } from "./listing.ts";

/** A listed animal at a shelter in good standing: every clause satisfied. */
const LISTED_ANIMAL: AnimalFacts = { availability: "Available" };
const GOOD_STANDING: ShelterFacts = {
  latestVerificationOutcome: "Verified",
  contactPointCount: 1,
  departedAt: null,
};

describe("isListed", () => {
  it("lists an available animal at a verified, reachable, present shelter", () => {
    expect(isListed(LISTED_ANIMAL, GOOD_STANDING)).toBe(true);
  });

  /**
   * Each of the four clauses failing alone, with the other three satisfied. Together
   * rather than one at a time so that a clause quietly dropped from the expression is a
   * failure here and not a silently broader listing.
   */
  describe("each clause alone is enough to delist", () => {
    it("an animal that is no longer available", () => {
      expect(isListed({ availability: "Adopted" }, GOOD_STANDING)).toBe(false);
      expect(
        isListed({ availability: "NoLongerAvailable" }, GOOD_STANDING),
      ).toBe(false);
    });

    /**
     * Both non-`Verified` outcomes, asserted separately rather than as one case, because
     * the rule tests *for* `Verified` and a rule rewritten to test *against* `Revoked`
     * would still pass with only the revoked half here — and would list every refused
     * shelter on the platform.
     */
    it("a shelter whose latest verification entry is not Verified", () => {
      expect(
        isListed(LISTED_ANIMAL, {
          ...GOOD_STANDING,
          latestVerificationOutcome: "Revoked",
        }),
      ).toBe(false);
      expect(
        isListed(LISTED_ANIMAL, {
          ...GOOD_STANDING,
          latestVerificationOutcome: "Refused",
        }),
      ).toBe(false);
    });

    it("a shelter with no verification entry at all — pending, not a stored state", () => {
      expect(
        isListed(LISTED_ANIMAL, {
          ...GOOD_STANDING,
          latestVerificationOutcome: null,
        }),
      ).toBe(false);
    });

    it("a shelter offering no contact point", () => {
      expect(
        isListed(LISTED_ANIMAL, { ...GOOD_STANDING, contactPointCount: 0 }),
      ).toBe(false);
    });

    it("a shelter that has left the platform", () => {
      expect(
        isListed(LISTED_ANIMAL, {
          ...GOOD_STANDING,
          departedAt: new Date("2026-01-01T00:00:00Z"),
        }),
      ).toBe(false);
    });
  });

  it("delists a departure the moment it is dated, before the contact surface goes", () => {
    // ADR 0015 separates the two halves: delisting is immediate, destruction waits thirty
    // days. A shelter inside its grace window still has its contact points, so the
    // contact-point clause has not fired yet and only `departedAt` can do this job.
    const departing: ShelterFacts = {
      latestVerificationOutcome: "Verified",
      contactPointCount: 3,
      departedAt: new Date("2026-01-01T00:00:00Z"),
    };
    expect(isListed(LISTED_ANIMAL, departing)).toBe(false);
  });
});

// `isListed` deliberately takes no `now`, unlike every other derivation in this package:
// silence never ends a listing (ADR 0001), so there is no clock for one to read. There is
// no test for that here on purpose — the parameter list is the compiler's business, and
// issue #50 asks for tests that "assert behaviour, not call shapes".
