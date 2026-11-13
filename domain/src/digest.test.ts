import { describe, expect, it } from "vitest";
import {
  composeDigest,
  type DigestAnimal,
  digestCandidates,
  digestIdempotencyKey,
  DIGEST_DAILY_BUDGET,
} from "./digest.ts";

describe("digest arithmetic", () => {
  it("keys a send per recipient per period, so a retry is a no-op", () => {
    expect(digestIdempotencyKey("2026-09-02", "sub-1")).toBe(
      "digest/2026-09-02/sub-1",
    );
    expect(digestIdempotencyKey("2026-09-02", "sub-1")).toBe(
      digestIdempotencyKey("2026-09-02", "sub-1"),
    );
    expect(digestIdempotencyKey("2026-09-03", "sub-1")).not.toBe(
      digestIdempotencyKey("2026-09-02", "sub-1"),
    );
  });

  it("reserves 30 of the day's 100 emails for mail a shelter cannot do without", () => {
    expect(DIGEST_DAILY_BUDGET).toBe(70);
  });
});

describe("digestCandidates", () => {
  const NOW = new Date("2026-09-02T11:00:00.000Z");
  const dog = (
    id: string,
    over: Partial<DigestAnimal> = {},
  ): DigestAnimal => ({
    id,
    bondedGroupId: null,
    demo: false,
    species: "dog",
    region: "Miranda",
    sex: "Female",
    size: "Medium",
    estimatedBirthDate: new Date("2024-01-01T00:00:00.000Z"),
    goodWith: { children: "Unknown", dogs: "Unknown", cats: "Unknown" },
    ...over,
  });

  it("offers what matches and leaves out what this subscription was already sent", () => {
    const listed = [dog("a"), dog("b"), dog("c", { species: "cat", size: null })];
    expect(
      digestCandidates(listed, { species: ["dog"] }, new Set(["a"]), NOW),
    ).toEqual([["b"]]);
  });

  it("matches a region the way a subscriber typed it, whatever case the shelter used", () => {
    expect(
      digestCandidates([dog("a", { region: "Miranda" })], { regions: ["miranda"] }, new Set(), NOW),
    ).toEqual([["a"]]);
  });

  it("offers a bonded group as one unit, matched as a group", () => {
    const listed = [
      dog("a", { bondedGroupId: "g" }),
      dog("b", { bondedGroupId: "g", goodWith: { children: "Unknown", dogs: "Unknown", cats: "No" } }),
      dog("c", { bondedGroupId: "h" }),
      dog("d", { bondedGroupId: "h" }),
    ];
    expect(digestCandidates(listed, {}, new Set(), NOW)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    // One member that is `No` with cats makes the pair `No` with cats.
    expect(digestCandidates(listed, { goodWith: ["cats"] }, new Set(), NOW)).toEqual([
      ["c", "d"],
    ]);
  });

  it("never offers an animal of the demo shelter, alone or in a bonded group", () => {
    expect(
      digestCandidates([dog("a", { demo: true }), dog("b")], {}, new Set(), NOW),
    ).toEqual([["b"]]);
    // One demo member keeps the whole group out, even a group that mixes in real animals.
    const listed = [
      dog("c", { bondedGroupId: "g" }),
      dog("d", { bondedGroupId: "g", demo: true }),
      dog("e", { bondedGroupId: "h", demo: true }),
      dog("f", { bondedGroupId: "h", demo: true }),
    ];
    expect(digestCandidates(listed, {}, new Set(), NOW)).toEqual([]);
  });

  it("counts a group as sent only once every member has been sent", () => {
    const listed = [dog("a", { bondedGroupId: "g" }), dog("b", { bondedGroupId: "g" })];
    expect(digestCandidates(listed, {}, new Set(["a", "b"]), NOW)).toEqual([]);
    // A member who joined after the group went out makes the group news again.
    expect(digestCandidates(listed, {}, new Set(["a"]), NOW)).toEqual([["a", "b"]]);
  });

  it("reaches a Young subscriber once the puppy has grown into the band", () => {
    const pup = dog("a", { estimatedBirthDate: new Date("2025-10-01T00:00:00.000Z") });
    const young = { species: ["dog" as const], ageBands: ["Young" as const] };
    expect(digestCandidates([pup], young, new Set(), NOW)).toEqual([]);
    expect(
      digestCandidates([pup], young, new Set(), new Date("2026-10-08T11:00:00.000Z")),
    ).toEqual([["a"]]);
  });
});

describe("composeDigest", () => {
  const units = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => [`${prefix}-${i}`]);

  it("shows twelve per search and counts the rest as more", () => {
    const [section] = composeDigest([{ subscriptionId: "a", units: units("dog", 15) }]);
    expect(section!.units).toEqual(units("dog", 12));
    expect(section!.more).toBe(3);
    expect(section!.repeats).toEqual([]);
  });

  it("stops at twenty-four rows across searches, in the order given", () => {
    const sections = composeDigest([
      { subscriptionId: "a", units: units("dog", 12) },
      { subscriptionId: "b", units: units("cat", 12) },
      { subscriptionId: "c", units: units("bird", 5) },
    ]);
    expect(sections.map((s) => [s.units.length, s.more])).toEqual([
      [12, 0],
      [12, 0],
      [0, 5],
    ]);
  });

  it("shows a unit two searches match once, under the first, and remembers it for both", () => {
    const bonded = ["dog-1", "dog-2"];
    const [first, second] = composeDigest([
      { subscriptionId: "a", units: [bonded] },
      { subscriptionId: "b", units: [bonded, ["cat-1"]] },
    ]);
    expect(first!.units).toEqual([bonded]);
    expect(second!.units).toEqual([["cat-1"]]);
    expect(second!.repeats).toEqual([bonded]);
    expect(second!.more).toBe(0);
  });
});
