import { describe, expect, it } from "vitest";
import { type AgeBand, deriveAgeBand, monthsBetween } from "./age-band.ts";
import type { Species } from "./axes.ts";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * Exact whole months after `from`, in UTC. Every birth date below is the 15th, so no month
 * is short enough to make this roll over into the next one.
 */
const monthsAfter = (from: Date, months: number) =>
  new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      from.getUTCDate(),
    ),
  );

describe("monthsBetween", () => {
  it("counts a partial month as not yet elapsed", () => {
    expect(monthsBetween(at("2026-01-15"), at("2026-02-14"))).toBe(0);
    expect(monthsBetween(at("2026-01-15"), at("2026-02-15"))).toBe(1);
  });

  it("floors a future birth date at zero rather than going negative", () => {
    expect(monthsBetween(at("2027-01-01"), at("2026-01-01"))).toBe(0);
  });
});

describe("deriveAgeBand", () => {
  const BORN = at("2020-01-15");

  /**
   * Both sides of every graduation, per species. A dog's are 12, 36 and 96 months; a
   * cat's are 12, 36 and 120 — the two species share the *shape* of the table and none of
   * the last threshold, and only `Young`, `Adult` and `Senior` share a name.
   *
   * The edges are the whole point: a threshold is a number that re-bands every animal in
   * the platform at once, and an off-by-one on `<` versus `<=` is invisible anywhere but
   * here.
   */
  const cases: ReadonlyArray<
    readonly [species: Species, months: number, band: AgeBand]
  > = [
    ["dog", 0, "Puppy"],
    ["dog", 11, "Puppy"],
    ["dog", 12, "Young"],
    ["dog", 35, "Young"],
    ["dog", 36, "Adult"],
    ["dog", 95, "Adult"],
    ["dog", 96, "Senior"],
    ["dog", 240, "Senior"],
    ["cat", 0, "Kitten"],
    ["cat", 11, "Kitten"],
    ["cat", 12, "Young"],
    ["cat", 35, "Young"],
    ["cat", 36, "Adult"],
    ["cat", 119, "Adult"],
    ["cat", 120, "Senior"],
    ["cat", 300, "Senior"],
  ];

  for (const [species, months, band] of cases) {
    it(`bands a ${months}-month-old ${species} as ${band}`, () => {
      expect(deriveAgeBand(species, BORN, monthsAfter(BORN, months))).toBe(
        band,
      );
    });
  }

  it("never derives the other species' first band", () => {
    // The type admits ("cat", "Puppy") and the derivation never produces it — the cost
    // ADR 0017 accepted knowingly, asserted rather than trusted.
    for (let months = 0; months <= 300; months++) {
      const asOf = monthsAfter(BORN, months);
      expect(deriveAgeBand("cat", BORN, asOf)).not.toBe("Puppy");
      expect(deriveAgeBand("dog", BORN, asOf)).not.toBe("Kitten");
    }
  });

  it("keeps a cat Adult at an age that has made a dog Senior", () => {
    const asOf = monthsAfter(BORN, 96);
    expect(deriveAgeBand("dog", BORN, asOf)).toBe("Senior");
    expect(deriveAgeBand("cat", BORN, asOf)).toBe("Adult");
  });

  it("graduates an animal with no write to it — the whole point of ADR 0004", () => {
    const born = at("2025-01-01");
    const theDayBefore = at("2025-12-31");
    const theDayAfter = at("2026-01-01");
    expect(deriveAgeBand("dog", born, theDayBefore)).toBe("Puppy");
    expect(deriveAgeBand("dog", born, theDayAfter)).toBe("Young");
  });

  it("treats a birth date in the future as newborn rather than rejecting it", () => {
    expect(deriveAgeBand("dog", at("2027-01-01"), at("2026-01-01"))).toBe(
      "Puppy",
    );
  });
});
