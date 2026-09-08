import { describe, expect, it } from "vitest";
import {
  MAX_CRITERIA_VALUES_PER_AXIS,
  MAX_REGION_LENGTH,
  parseCriteria,
  readCriteria,
  writeCriteria,
} from "./criteria.ts";

describe("parseCriteria", () => {
  it("keeps only values from each axis's closed vocabulary", () => {
    const parsed = parseCriteria({
      species: ["dog", "hamster", "cat"],
      sizes: ["Small", "Enormous"],
      sexes: ["Female", "female"],
      // `Baby` is not an `AgeBand`; issue #48 settled that the first band is named for the
      // species. A stale form or a hand-written query submitting it must match nothing
      // rather than throw.
      ageBands: ["Puppy", "Baby"],
      goodWith: ["cats", "lizards"],
    });
    expect(parsed).toEqual({
      species: ["dog", "cat"],
      sizes: ["Small"],
      sexes: ["Female"],
      ageBands: ["Puppy"],
      goodWith: ["cats"],
    });
  });

  it("is a set: duplicates collapse and order is canonical", () => {
    expect(
      parseCriteria({ regions: ["carabobo", "aragua", "carabobo"] }),
    ).toEqual({
      regions: ["aragua", "carabobo"],
    });
    expect(parseCriteria({ species: ["cat", "dog"] })).toEqual(
      parseCriteria({ species: ["dog", "cat", "dog"] }),
    );
  });

  /**
   * Canonical order is the **vocabulary's** own order for a closed axis, not alphabetical,
   * because the stored set is read back to the subscriber on the manage page (#62) and in
   * every digest section header (#64). `Cachorro, Joven, Adulto` is the order a reader
   * expects of a life stage; `Adulto, Cachorro, Joven, Senior` is what sorting the English
   * identifiers would have produced, and it reads as a bug in Spanish.
   *
   * Regions are the exception and take lexicographic order, because they are the one open
   * vocabulary (ADR 0005) and have no order of their own to preserve.
   */
  it("orders a closed axis by its vocabulary and regions lexicographically", () => {
    expect(
      parseCriteria({ ageBands: ["Senior", "Puppy", "Adult", "Young"] }).ageBands,
    ).toEqual(["Puppy", "Young", "Adult", "Senior"]);
    expect(
      parseCriteria({ sizes: ["Giant", "Small", "Large", "Medium"] }).sizes,
    ).toEqual(["Small", "Medium", "Large", "Giant"]);
    expect(
      parseCriteria({ goodWith: ["cats", "children", "dogs"] }).goodWith,
    ).toEqual(["children", "dogs", "cats"]);
    expect(
      parseCriteria({ regions: ["zulia", "aragua", "miranda"] }).regions,
    ).toEqual(["aragua", "miranda", "zulia"]);
  });

  /**
   * The whole point of the ticket's "sets, not scalars" criterion, and region is the axis
   * ADR 0005 named: a subscriber in the Caracas commuter belt watches three states at once.
   */
  it("lets one subscription name several regions", () => {
    const parsed = parseCriteria({
      regions: ["aragua", "carabobo", "miranda"],
    });
    expect(parsed.regions).toEqual(["aragua", "carabobo", "miranda"]);
  });

  it("drops an empty axis rather than storing an empty array", () => {
    expect(parseCriteria({ species: [], regions: ["aragua"] })).toEqual({
      regions: ["aragua"],
    });
    expect(parseCriteria({ species: ["hamster"] })).toEqual({});
  });

  it("trims and lower-cases a region but leaves the closed vocabularies alone", () => {
    expect(parseCriteria({ regions: ["  Aragua  ", "CARABOBO"] })).toEqual({
      regions: ["aragua", "carabobo"],
    });
  });

  it("refuses a region longer than the column is meant to hold", () => {
    const tooLong = "a".repeat(MAX_REGION_LENGTH + 1);
    expect(parseCriteria({ regions: [tooLong, "aragua"] })).toEqual({
      regions: ["aragua"],
    });
  });

  it("bounds how many values one axis may carry", () => {
    const many = Array.from(
      { length: MAX_CRITERIA_VALUES_PER_AXIS + 5 },
      (_, i) => `region-${String(i).padStart(3, "0")}`,
    );
    expect(parseCriteria({ regions: many }).regions).toHaveLength(
      MAX_CRITERIA_VALUES_PER_AXIS,
    );
  });

  it("ignores anything that is not an array of strings", () => {
    expect(
      parseCriteria({
        species: "dog",
        regions: [1, null, "aragua"],
        nonsense: ["x"],
      }),
    ).toEqual({ regions: ["aragua"] });
  });
});

describe("writeCriteria and readCriteria", () => {
  it("round-trips every axis", () => {
    const criteria = parseCriteria({
      species: ["dog"],
      regions: ["aragua", "carabobo"],
      sizes: ["Medium", "Large"],
      ageBands: ["Adult"],
      sexes: ["Female"],
      goodWith: ["cats", "children"],
    });
    expect(readCriteria(writeCriteria(criteria))).toEqual(criteria);
  });

  /**
   * The stored form is canonical, so two subscribers who checked the same boxes in a
   * different order hold byte-identical rows. That is what makes the column comparable at
   * all — and it is why `writeCriteria` goes through the parser rather than around it.
   */
  it("is byte-identical whatever order the form submitted", () => {
    const a = writeCriteria(parseCriteria({ regions: ["carabobo", "aragua"] }));
    const b = writeCriteria(parseCriteria({ regions: ["aragua", "carabobo"] }));
    expect(a).toBe(b);
  });

  it("reads an empty criteria back as constraining nothing", () => {
    expect(readCriteria(writeCriteria({}))).toEqual({});
  });

  /**
   * A column is read far more often than it is written, and it is read by the digest — the
   * one consumer whose failure is invisible. Garbage must degrade to "constrains nothing"
   * rather than throw a whole run away, and the row that produced it is still wrong, so the
   * caller is told by getting an empty object rather than by an exception it cannot handle
   * mid-shard.
   */
  it("survives a column that is not the JSON it should be", () => {
    expect(readCriteria("not json")).toEqual({});
    expect(readCriteria("[1,2,3]")).toEqual({});
    expect(readCriteria("null")).toEqual({});
    expect(readCriteria('{"species":["dog"],"regions":"caracas"}')).toEqual({
      species: ["dog"],
    });
  });
});
