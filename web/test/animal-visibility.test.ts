import type {
  Availability,
  ShelterFacts,
  VerificationOutcome,
} from "@pawster/domain";
import { AVAILABILITIES, isListed } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import { publicView } from "../src/lib/animals/visibility.ts";

/**
 * What the public gets for one animal, as a table over every way it can be answered.
 *
 * The suite exists mostly for one property — that {@link publicView} and `isListed()` cannot
 * drift apart — and a table is the only way to assert it, because the interesting cases are
 * *combinations* rather than individual clauses.
 */

const OUTCOMES: readonly (VerificationOutcome | null)[] = [
  null,
  "Verified",
  "Refused",
  "Revoked",
];

function shelterFacts(overrides: Partial<ShelterFacts> = {}): ShelterFacts {
  return {
    latestVerificationOutcome: "Verified",
    contactPointCount: 1,
    departedAt: null,
    ...overrides,
  };
}

/** Every combination of the facts the two rules are given. 3 × 4 × 2 × 2 = 48 of them. */
function* everyCase(): Generator<{
  availability: Availability;
  shelter: ShelterFacts;
}> {
  for (const availability of AVAILABILITIES) {
    for (const latestVerificationOutcome of OUTCOMES) {
      for (const contactPointCount of [0, 2]) {
        for (const departedAt of [null, new Date("2026-06-01")]) {
          yield {
            availability,
            shelter: {
              latestVerificationOutcome,
              contactPointCount,
              departedAt,
            },
          };
        }
      }
    }
  }
}

describe("the public view of an animal", () => {
  it("says listed for exactly the animals isListed() says are listed", async () => {
    /**
     * The property that keeps the two in step. A fifth clause added to `isListed()` fails here
     * rather than quietly producing an archive page with no wording for it — which is the
     * failure mode of a rule that is the *complement* of another rule and lives in a different
     * file.
     */
    for (const { availability, shelter } of everyCase()) {
      const view = publicView({ availability }, shelter);
      expect(
        view.kind === "listed",
        `${availability} / ${shelter.latestVerificationOutcome} / ` +
          `${shelter.contactPointCount} contacts / departed=${shelter.departedAt !== null}`,
      ).toBe(isListed({ availability }, shelter));
    }
  });

  it("hides everything an unverified shelter published, whatever else is true", () => {
    /**
     * Pending, refused and revoked all answer the same way, and revoked is the one worth
     * naming: `CONTEXT.md` says a Revocation delists a shelter's animals "without archiving
     * them". The platform has withdrawn its judgement, and an archive page under that shelter
     * would be the platform still vouching for it.
     *
     * Pending and refused are simpler — the animal was never publicly reachable, so there is no
     * promise to an adopter to keep and a page would leak that the id is real.
     */
    for (const { availability, shelter } of everyCase()) {
      if (shelter.latestVerificationOutcome === "Verified") continue;
      expect(publicView({ availability }, shelter).kind).toBe("hidden");
    }
  });

  it("archives an adopted animal as adopted, even after its shelter has left", () => {
    /**
     * Both facts are true and only one is the answer to the question the adopter arrived with.
     * She found a home is the more specific, and the happier, so availability is read before
     * departure — which is why the clause order here is not `isListed()`'s.
     */
    const view = publicView(
      { availability: "Adopted" },
      shelterFacts({ departedAt: new Date("2026-06-01"), contactPointCount: 0 }),
    );
    expect(view).toEqual({ kind: "archived", reason: "Adopted" });
  });

  it("tells the two unavailable outcomes apart", () => {
    expect(publicView({ availability: "Adopted" }, shelterFacts())).toEqual({
      kind: "archived",
      reason: "Adopted",
    });
    expect(
      publicView({ availability: "NoLongerAvailable" }, shelterFacts()),
    ).toEqual({ kind: "archived", reason: "NoLongerAvailable" });
  });

  it("archives an available animal whose shelter left", () => {
    expect(
      publicView(
        { availability: "Available" },
        shelterFacts({ departedAt: new Date("2026-06-01") }),
      ),
    ).toEqual({ kind: "archived", reason: "ShelterDeparted" });
  });

  it("archives an available animal nobody can be reached about", () => {
    /**
     * The clause with no story, and the reason it is enumerated at all: it is unreachable
     * through any form — both shelter forms refuse an empty contact set — but `isListed()` can
     * return `false` for it, and an enumeration with a hole in it is a page that 404s on a state
     * nobody predicted. `CONTEXT.md` rules a dead link out.
     */
    expect(
      publicView({ availability: "Available" }, shelterFacts({ contactPointCount: 0 })),
    ).toEqual({ kind: "archived", reason: "ShelterUnreachable" });
  });

  it("never answers hidden for a verified shelter, so no animal it published 404s", () => {
    // The promise `CONTEXT.md` makes to adopters, stated as a property: once a shelter is
    // verified, every animal it published has a page for as long as the platform exists.
    for (const { availability, shelter } of everyCase()) {
      if (shelter.latestVerificationOutcome !== "Verified") continue;
      expect(publicView({ availability }, shelter).kind).not.toBe("hidden");
    }
  });
});
