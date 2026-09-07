import { describe, expect, it } from "vitest";
import {
  type StalenessBand,
  daysBetween,
  deriveStalenessBand,
} from "./staleness.ts";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("daysBetween", () => {
  it("counts a partial day as not yet elapsed", () => {
    expect(
      daysBetween(at("2026-01-01"), new Date("2026-01-01T23:59:59Z")),
    ).toBe(0);
    expect(daysBetween(at("2026-01-01"), at("2026-01-02"))).toBe(1);
  });

  it("floors a confirmation in the future at zero rather than going negative", () => {
    expect(daysBetween(at("2026-02-01"), at("2026-01-01"))).toBe(0);
  });
});

describe("deriveStalenessBand", () => {
  /**
   * ADR 0001 fixes the bands at fresh <= 30 days, ageing 31-90, stale > 90. Both sides of
   * both graduations are here, because an off-by-one in a band nobody tested at the edge
   * re-labels and re-sorts the whole listing at once.
   */
  const cases: ReadonlyArray<readonly [days: number, band: StalenessBand]> = [
    [0, "Fresh"],
    [1, "Fresh"],
    [29, "Fresh"],
    [30, "Fresh"],
    [31, "Ageing"],
    [32, "Ageing"],
    [89, "Ageing"],
    [90, "Ageing"],
    [91, "Stale"],
    [92, "Stale"],
    [365, "Stale"],
  ];

  const lastConfirmedAt = at("2026-01-01");

  for (const [days, band] of cases) {
    it(`is ${band} ${days} day(s) after the last confirmation`, () => {
      const asOf = new Date(lastConfirmedAt.getTime() + days * 86_400_000);
      expect(deriveStalenessBand(lastConfirmedAt, asOf)).toBe(band);
    });
  }

  it("reads the clock from its argument, so no test here waits for one", () => {
    expect(deriveStalenessBand(lastConfirmedAt, at("2026-01-31"))).toBe(
      "Fresh",
    );
    expect(deriveStalenessBand(lastConfirmedAt, at("2026-02-01"))).toBe(
      "Ageing",
    );
  });
});
