import { describe, expect, it } from "vitest";
import type { GoodWithFlags, Sex, Size, Species } from "./axes.ts";
import { parseCriteria } from "./criteria.ts";
import type { ListedAnimal } from "./filter-index.ts";
import {
  compareByFreshestConfirmed,
  indexGeneratedAt,
  indexObjectKey,
  INDEX_POINTER_KEY,
  INDEX_PREFIX,
  isSupersededIndexObject,
  parseIndex,
  selectListed,
  serializeIndex,
  SUPERSEDED_INDEX_GRACE_MS,
} from "./filter-index.ts";

const ALL_UNKNOWN: GoodWithFlags = {
  children: "Unknown",
  dogs: "Unknown",
  cats: "Unknown",
};

function listed(overrides: Partial<ListedAnimal> = {}): ListedAnimal {
  return {
    id: "a1",
    name: "Canela",
    species: "dog",
    region: "Miranda",
    size: "Medium",
    sex: "Female",
    estimatedBirthDate: new Date("2025-01-01T00:00:00.000Z"),
    lastConfirmedAt: new Date("2026-09-01T14:30:00.000Z"),
    goodWith: { children: "Yes", dogs: "Yes", cats: "Unknown" },
    thumbnailKey: "d/abc123.webp",
    bondedGroupId: null,
    urgent: false,
    shelterId: "s1",
    ...overrides,
  };
}

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("the index's wire shape", () => {
  it("round-trips every field of an animal", () => {
    const animal = listed({
      size: null,
      species: "cat",
      sex: "Unknown",
      goodWith: { children: "No", dogs: "Yes", cats: "Unknown" },
      bondedGroupId: "g1",
      urgent: true,
    });

    const [decoded] = parseIndex(
      serializeIndex({ generatedAt: "2026-09-08", animals: [animal] }),
    ).animals;

    expect(decoded).toEqual(animal);
  });

  it("round-trips a dog carrying every size", () => {
    const sizes: Size[] = ["Small", "Medium", "Large", "Giant"];
    const animals = sizes.map((size, at) => listed({ id: `a${at}`, size }));

    const decoded = parseIndex(
      serializeIndex({ generatedAt: "2026-09-08", animals }),
    ).animals;

    expect(decoded.map((animal) => animal.size)).toEqual(sizes);
  });

  it("round-trips every sex and every species", () => {
    const sexes: Sex[] = ["Male", "Female", "Unknown"];
    const species: Species[] = ["dog", "cat"];
    const animals = sexes.flatMap((sex, sexAt) =>
      species.map((kind, at) =>
        listed({
          id: `a${sexAt}${at}`,
          sex,
          species: kind,
          size: kind === "dog" ? "Medium" : null,
        }),
      ),
    );

    const decoded = parseIndex(
      serializeIndex({ generatedAt: "2026-09-08", animals }),
    ).animals;

    expect(decoded.map((animal) => [animal.sex, animal.species])).toEqual(
      animals.map((animal) => [animal.sex, animal.species]),
    );
  });

  /**
   * The acceptance criterion stated as an assertion over the bytes rather than over the
   * decoded object, because the failure it guards against is a *field being added*: a
   * regenerator that helpfully wrote the band it had just derived would still decode into a
   * `ListedAnimal` with no band on it, and this is the only place that would notice.
   */
  it("carries both dates and no band of any kind", () => {
    const text = serializeIndex({
      generatedAt: "2026-09-08",
      animals: [listed()],
    });

    expect(text).toContain('"b":"2025-01-01"');
    expect(text).toContain(`"f":${new Date("2026-09-01T14:30:00.000Z").getTime()}`);
    for (const band of ["Puppy", "Kitten", "Young", "Adult", "Senior"]) {
      expect(text).not.toContain(band);
    }
    for (const band of ["Fresh", "Ageing", "Stale"]) {
      expect(text).not.toContain(band);
    }
  });

  it("keeps a confirmation's time of day, so a shelterful does not tie", () => {
    const morning = listed({
      id: "a1",
      lastConfirmedAt: new Date("2026-09-01T08:00:00.000Z"),
    });
    const evening = listed({
      id: "a2",
      lastConfirmedAt: new Date("2026-09-01T20:00:00.000Z"),
    });

    const decoded = parseIndex(
      serializeIndex({ generatedAt: "2026-09-08", animals: [morning, evening] }),
    ).animals;

    expect(decoded[0]?.lastConfirmedAt.toISOString()).toBe(
      "2026-09-01T08:00:00.000Z",
    );
    expect(decoded[1]?.lastConfirmedAt.toISOString()).toBe(
      "2026-09-01T20:00:00.000Z",
    );
  });

  /**
   * ADR 0018's free nightly no-op rests entirely on this: identical data must serialize to
   * identical bytes, or every run mints a new key and leaves an orphan.
   */
  it("serializes identical bytes whatever order the animals arrive in", () => {
    const animals = [
      listed({ id: "a3" }),
      listed({ id: "a1" }),
      listed({ id: "a2" }),
    ];

    const forwards = serializeIndex({ generatedAt: "2026-09-08", animals });
    const backwards = serializeIndex({
      generatedAt: "2026-09-08",
      animals: [...animals].reverse(),
    });

    expect(forwards).toBe(backwards);
    expect(parseIndex(forwards).animals.map((animal) => animal.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("stamps the generated day rather than the instant, so a day of runs agrees", () => {
    const morning = indexGeneratedAt(new Date("2026-09-08T03:12:08.000Z"));
    const evening = indexGeneratedAt(new Date("2026-09-08T23:59:59.000Z"));

    expect(morning).toBe("2026-09-08");
    expect(evening).toBe(morning);
  });

  it("refuses a token it does not know rather than substituting a default", () => {
    const text = serializeIndex({
      generatedAt: "2026-09-08",
      animals: [listed()],
    }).replace('"s":"D"', '"s":"X"');

    expect(() => parseIndex(text)).toThrow(/unknown species/);
  });

  it("refuses a version it was not written for", () => {
    const text = serializeIndex({
      generatedAt: "2026-09-08",
      animals: [listed()],
    }).replace('"v":1', '"v":2');

    expect(() => parseIndex(text)).toThrow(/unsupported version/);
  });
});

describe("the ordering", () => {
  /**
   * The direction, pinned with real dates. Asserting the *sign* of one comparison would pass
   * for the inverted comparator just as happily — a mistyped subtraction still returns a
   * number of the shape a test like that is looking for. So this sorts a list whose freshest
   * and stalest members are unambiguous and reads off which one leads.
   *
   * #17 found this backwards on its first draft, leading the listing with the stalest
   * animals, and ADR 0001 is what makes that expensive rather than cosmetic: freshest-first
   * is the incentive that makes the monthly confirmation nudge worth answering.
   */
  it("leads with the freshest-confirmed animal and ends with the stalest", () => {
    const stale = listed({
      id: "stale",
      lastConfirmedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const middling = listed({
      id: "middling",
      lastConfirmedAt: new Date("2026-07-15T00:00:00.000Z"),
    });
    const fresh = listed({
      id: "fresh",
      lastConfirmedAt: new Date("2026-09-07T00:00:00.000Z"),
    });

    const order = [stale, fresh, middling]
      .sort(compareByFreshestConfirmed)
      .map((animal) => animal.id);

    expect(order).toEqual(["fresh", "middling", "stale"]);
  });

  it("is a total order, so a shelterful confirmed at once does not shuffle", () => {
    const at = new Date("2026-09-01T09:00:00.000Z");
    const shelterful = [
      listed({ id: "c", lastConfirmedAt: at }),
      listed({ id: "a", lastConfirmedAt: at }),
      listed({ id: "b", lastConfirmedAt: at }),
    ];

    expect(
      [...shelterful].sort(compareByFreshestConfirmed).map((a) => a.id),
    ).toEqual(["a", "b", "c"]);
    expect(
      [...shelterful].reverse().sort(compareByFreshestConfirmed).map((a) => a.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not move an urgent animal, because urgency is not a sort key", () => {
    const urgentAndStale = listed({
      id: "urgent",
      urgent: true,
      lastConfirmedAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const quietAndFresh = listed({
      id: "quiet",
      lastConfirmedAt: new Date("2026-09-06T00:00:00.000Z"),
    });

    expect(
      [urgentAndStale, quietAndFresh]
        .sort(compareByFreshestConfirmed)
        .map((animal) => animal.id),
    ).toEqual(["quiet", "urgent"]);
  });
});

describe("what an adopter's filters leave", () => {
  it("returns everything, freshest first, when nothing is filtered", () => {
    const animals = [
      listed({ id: "old", lastConfirmedAt: new Date("2026-01-01T00:00:00.000Z") }),
      listed({ id: "new", lastConfirmedAt: new Date("2026-09-07T00:00:00.000Z") }),
    ];

    expect(selectListed(animals, {}, NOW).map((a) => a.id)).toEqual([
      "new",
      "old",
    ]);
  });

  /**
   * The trap this filter would otherwise fall into, pinned.
   *
   * `criteria.ts` normalises every submitted region to a lower-cased identifier; an animal
   * carries its region as its shelter typed it, because that string is what a card displays.
   * `matches` compares by membership, so a filter that did not normalise the animal's side
   * would exclude every animal on the platform on the region axis while every other axis
   * worked — which is why this is asserted through `parseCriteria` rather than with a
   * hand-built criteria object that would agree with itself.
   */
  it("matches a region whatever case the adopter's filter arrived in", () => {
    const animals = [listed({ id: "miranda", region: "Miranda" })];

    for (const submitted of ["Miranda", "miranda", " MIRANDA "]) {
      expect(
        selectListed(animals, parseCriteria({ regions: [submitted] }), NOW),
      ).toHaveLength(1);
    }
  });

  it("still excludes a region the adopter did not ask for", () => {
    const animals = [listed({ id: "miranda", region: "Miranda" })];

    expect(
      selectListed(animals, parseCriteria({ regions: ["Zulia"] }), NOW),
    ).toHaveLength(0);
  });

  /** Several regions at once — "Carabobo or Aragua, I'll drive" is a real sentence. */
  it("accepts several regions at once", () => {
    const animals = [
      listed({ id: "carabobo", region: "Carabobo" }),
      listed({ id: "aragua", region: "Aragua" }),
      listed({ id: "zulia", region: "Zulia" }),
    ];

    /** Identifiers, which is what a criteria holds — see the case test above. */
    const left = selectListed(
      animals,
      { regions: ["carabobo", "aragua"] },
      NOW,
    );

    expect(left.map((animal) => animal.id).sort()).toEqual([
      "aragua",
      "carabobo",
    ]);
  });

  it("excludes only an explicit No on a good-with axis, and keeps the unknowns", () => {
    const yes = listed({
      id: "yes",
      goodWith: { ...ALL_UNKNOWN, cats: "Yes" },
    });
    const unknown = listed({ id: "unknown", goodWith: ALL_UNKNOWN });
    const no = listed({ id: "no", goodWith: { ...ALL_UNKNOWN, cats: "No" } });

    const left = selectListed([yes, unknown, no], { goodWith: ["cats"] }, NOW);

    expect(left.map((animal) => animal.id).sort()).toEqual(["unknown", "yes"]);
  });

  it("filters on all six axes at once", () => {
    const wanted = listed({
      id: "wanted",
      species: "dog",
      region: "Aragua",
      size: "Large",
      sex: "Female",
      // Two years old at NOW, which for a dog is `Young`: the band is 13-36 months.
      estimatedBirthDate: new Date("2024-09-01T00:00:00.000Z"),
      goodWith: { children: "Yes", dogs: "Yes", cats: "Unknown" },
    });
    const wrongSpecies = listed({ ...wanted, id: "cat", species: "cat", size: null });
    const wrongRegion = listed({ ...wanted, id: "region", region: "Zulia" });
    const wrongSize = listed({ ...wanted, id: "size", size: "Small" });
    const wrongSex = listed({ ...wanted, id: "sex", sex: "Male" });
    const wrongBand = listed({
      ...wanted,
      id: "band",
      estimatedBirthDate: new Date("2026-08-01T00:00:00.000Z"),
    });
    const knownNo = listed({
      ...wanted,
      id: "no",
      goodWith: { children: "No", dogs: "Yes", cats: "Unknown" },
    });

    const left = selectListed(
      [wanted, wrongSpecies, wrongRegion, wrongSize, wrongSex, wrongBand, knownNo],
      {
        species: ["dog"],
        regions: ["aragua", "carabobo"],
        sizes: ["Large"],
        sexes: ["Female"],
        ageBands: ["Young"],
        goodWith: ["children"],
      },
      NOW,
    );

    expect(left.map((animal) => animal.id)).toEqual(["wanted"]);
  });

  /**
   * The band is derived from the date at the moment the filter is applied, which is the
   * whole reason the index carries no band: the same bytes answer a different question a
   * year later without anybody rewriting them.
   */
  it("re-bands an animal as time passes, over the same index bytes", () => {
    const puppy = listed({
      id: "puppy",
      species: "dog",
      estimatedBirthDate: new Date("2026-06-01T00:00:00.000Z"),
    });
    const animals = parseIndex(
      serializeIndex({ generatedAt: "2026-09-08", animals: [puppy] }),
    ).animals;

    expect(selectListed(animals, { ageBands: ["Puppy"] }, NOW)).toHaveLength(1);
    expect(
      selectListed(animals, { ageBands: ["Puppy"] }, new Date("2028-09-08T00:00:00.000Z")),
    ).toHaveLength(0);
    expect(
      selectListed(animals, { ageBands: ["Young"] }, new Date("2028-09-08T00:00:00.000Z")),
    ).toHaveLength(1);
  });
});

describe("keeping the i/ prefix", () => {
  const aged = new Date(NOW.getTime() - SUPERSEDED_INDEX_GRACE_MS - 1);

  it("never collects the pointer, which lives in the same prefix", () => {
    expect(
      isSupersededIndexObject(
        { key: INDEX_POINTER_KEY, uploaded: aged },
        { pointerKey: indexObjectKey("abc"), now: NOW },
      ),
    ).toBe(false);
  });

  it("never collects the index the pointer names, however old it is", () => {
    const live = indexObjectKey("abc");

    expect(
      isSupersededIndexObject(
        { key: live, uploaded: new Date("2020-01-01T00:00:00.000Z") },
        { pointerKey: live, now: NOW },
      ),
    ).toBe(false);
  });

  it("gives a superseded index an hour's grace, for a reader between its two fetches", () => {
    const superseded = indexObjectKey("stale");
    const live = { pointerKey: indexObjectKey("abc"), now: NOW };

    expect(
      isSupersededIndexObject(
        { key: superseded, uploaded: new Date(NOW.getTime() - 60_000) },
        live,
      ),
    ).toBe(false);
    expect(
      isSupersededIndexObject({ key: superseded, uploaded: aged }, live),
    ).toBe(true);
  });

  it("keys the index by its bytes, under the prefix reclamation does not sweep", () => {
    expect(indexObjectKey("9f3ac14e")).toBe("i/9f3ac14e.json");
    expect(INDEX_POINTER_KEY.startsWith(INDEX_PREFIX)).toBe(true);
  });
});
