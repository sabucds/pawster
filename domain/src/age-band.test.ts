import { describe, expect, it } from "vitest";
import { deriveAgeBand, monthsBetween } from "./age-band.ts";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

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
  it("bands a dog by months since its estimated birth date", () => {
    const born = at("2025-01-01");
    expect(deriveAgeBand("dog", born, at("2025-06-01"))).toBe("Puppy");
    expect(deriveAgeBand("dog", born, at("2026-01-01"))).toBe("Young");
    expect(deriveAgeBand("dog", born, at("2028-01-01"))).toBe("Adult");
    expect(deriveAgeBand("dog", born, at("2033-01-01"))).toBe("Senior");
  });

  it("names a cat's first band for its species and keeps it adult for longer", () => {
    const born = at("2025-01-01");
    expect(deriveAgeBand("cat", born, at("2025-06-01"))).toBe("Kitten");
    // A dog is Senior at 96 months; a cat of the same age is still Adult.
    expect(deriveAgeBand("cat", born, at("2033-01-01"))).toBe("Adult");
  });

  it("graduates an animal with no write to it — the whole point of ADR 0004", () => {
    const born = at("2025-01-01");
    const theDayBefore = at("2025-12-31");
    const theDayAfter = at("2026-01-01");
    expect(deriveAgeBand("dog", born, theDayBefore)).toBe("Puppy");
    expect(deriveAgeBand("dog", born, theDayAfter)).toBe("Young");
  });
});
