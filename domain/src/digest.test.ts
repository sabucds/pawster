import { describe, expect, it } from "vitest";
import {
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
