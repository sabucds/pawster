import { describe, expect, it } from "vitest";
import { GOOD_WITH_AXES, type GoodWithAxis, type Tri } from "./axes.ts";
import {
  type Animal,
  type BondedGroup,
  type SubscriptionCriteria,
  ageBandsFor,
  goodWithFor,
  matches,
} from "./matching.ts";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const NOW = at("2026-09-07");

const goodWithAll = (value: Tri) => ({
  children: value,
  dogs: value,
  cats: value,
});

/** A two-year-old female small dog in Caracas, tolerant of everything. */
const DOG: Animal = {
  species: "dog",
  region: "distrito-capital",
  sex: "Female",
  size: "Small",
  estimatedBirthDate: at("2024-09-07"),
  goodWith: goodWithAll("Yes"),
};

const CAT: Animal = {
  species: "cat",
  region: "miranda",
  sex: "Male",
  size: null,
  estimatedBirthDate: at("2024-09-07"),
  goodWith: goodWithAll("Yes"),
};

describe("matches — a single animal", () => {
  it("matches criteria that constrain nothing", () => {
    expect(matches({}, DOG, NOW)).toBe(true);
  });

  it("treats an empty axis as unconstrained rather than as matching nothing", () => {
    // An adopter who unchecks every region means "anywhere", not "nowhere". The form can
    // therefore submit what the checkboxes say without a special case for none of them.
    expect(matches({ regions: [] }, DOG, NOW)).toBe(true);
    expect(matches({ goodWith: [] }, DOG, NOW)).toBe(true);
  });

  it("filters on species", () => {
    expect(matches({ species: ["dog"] }, DOG, NOW)).toBe(true);
    expect(matches({ species: ["cat"] }, DOG, NOW)).toBe(false);
    expect(matches({ species: ["dog", "cat"] }, CAT, NOW)).toBe(true);
  });

  it("filters on several regions at once", () => {
    expect(matches({ regions: ["carabobo", "aragua"] }, DOG, NOW)).toBe(false);
    expect(
      matches({ regions: ["carabobo", "distrito-capital"] }, DOG, NOW),
    ).toBe(true);
  });

  it("filters on sex", () => {
    expect(matches({ sexes: ["Female"] }, DOG, NOW)).toBe(true);
    expect(matches({ sexes: ["Male"] }, DOG, NOW)).toBe(false);
  });

  it("never matches a size criterion for an animal that has no size", () => {
    // Size is asked of dogs only, so a cat's is null. A subscriber filtering on size is
    // asking about dogs, and answering "any size matches" for a cat would smuggle cats
    // into a dog subscription.
    expect(matches({ sizes: ["Small"] }, DOG, NOW)).toBe(true);
    expect(matches({ sizes: ["Large"] }, DOG, NOW)).toBe(false);
    expect(
      matches({ sizes: ["Small", "Medium", "Large", "Giant"] }, CAT, NOW),
    ).toBe(false);
  });

  it("filters on age band derived from the date, at the moment it is asked", () => {
    const born = at("2026-03-07"); // six months old at NOW
    const puppy: Animal = { ...DOG, estimatedBirthDate: born };
    expect(matches({ ageBands: ["Puppy"] }, puppy, NOW)).toBe(true);
    expect(matches({ ageBands: ["Young"] }, puppy, NOW)).toBe(false);

    // The same animal, unchanged, a year later. Nothing wrote to it — which is the whole
    // reason `now` is an argument and the band is not a field.
    const laterOn = at("2027-09-07");
    expect(matches({ ageBands: ["Puppy"] }, puppy, laterOn)).toBe(false);
    expect(matches({ ageBands: ["Young"] }, puppy, laterOn)).toBe(true);
  });

  describe("a good-with filter excludes only an explicit No", () => {
    const cases: ReadonlyArray<readonly [Tri, boolean]> = [
      ["Yes", true],
      ["Unknown", true],
      ["No", false],
    ];

    for (const [known, expected] of cases) {
      it(`${known} ${expected ? "matches" : "does not match"}`, () => {
        const animal: Animal = { ...DOG, goodWith: goodWithAll(known) };
        expect(matches({ goodWith: ["children"] }, animal, NOW)).toBe(expected);
      });
    }

    it("ignores an axis the subscriber did not ask about", () => {
      const wary: Animal = {
        ...DOG,
        goodWith: { children: "Yes", dogs: "No", cats: "No" },
      };
      expect(matches({ goodWith: ["children"] }, wary, NOW)).toBe(true);
      expect(matches({ goodWith: ["children", "cats"] }, wary, NOW)).toBe(
        false,
      );
    });

    it("enforces every axis in the vocabulary, not a hand-written three", () => {
      // Reads GOOD_WITH_AXES so that a fourth axis added to the vocabulary is covered by
      // this rule the moment it exists, rather than being silently exempt from it.
      for (const axis of GOOD_WITH_AXES) {
        const animal: Animal = {
          ...DOG,
          goodWith: { ...goodWithAll("Yes"), [axis]: "No" },
        };
        expect(matches({ goodWith: [axis] }, animal, NOW)).toBe(false);
      }
    });
  });
});

describe("matches — a bonded group", () => {
  /** Mother plus two pups: one Adult and two Puppies, adopted together or not at all. */
  const mother: Animal = { ...DOG, estimatedBirthDate: at("2021-09-07") };
  const pup = (name: string): Animal => ({
    ...DOG,
    estimatedBirthDate: at("2026-03-07"),
    sex: name === "a" ? "Male" : "Female",
  });
  const litter: BondedGroup = { members: [mother, pup("a"), pup("b")] };

  it("matches a Puppy subscriber and an Adult subscriber both — union on a descriptive axis", () => {
    expect(matches({ ageBands: ["Puppy"] }, litter, NOW)).toBe(true);
    expect(matches({ ageBands: ["Adult"] }, litter, NOW)).toBe(true);
    expect(matches({ ageBands: ["Senior"] }, litter, NOW)).toBe(false);
  });

  it("takes the union on every descriptive axis, not only the derived one", () => {
    const mixed: BondedGroup = { members: [DOG, CAT] };
    expect(matches({ species: ["dog"] }, mixed, NOW)).toBe(true);
    expect(matches({ species: ["cat"] }, mixed, NOW)).toBe(true);
    expect(matches({ sexes: ["Male"] }, mixed, NOW)).toBe(true);
    expect(matches({ sexes: ["Female"] }, mixed, NOW)).toBe(true);
    expect(matches({ regions: ["carabobo"] }, mixed, NOW)).toBe(false);
  });

  it("is a No pair when one member is a No — intersection on a safety axis", () => {
    const waryOfCats: Animal = {
      ...DOG,
      goodWith: { children: "Yes", dogs: "Yes", cats: "No" },
    };
    const pair: BondedGroup = { members: [DOG, waryOfCats] };
    expect(goodWithFor(pair, "cats")).toBe("No");
    expect(matches({ goodWith: ["cats"] }, pair, NOW)).toBe(false);
    // The tolerant member does not rescue the pair, because the adopter takes both.
    expect(matches({ goodWith: ["cats"] }, DOG, NOW)).toBe(true);
  });

  it("is Unknown where no member is a No and one is unrecorded, and still matches", () => {
    const unrecorded: Animal = {
      ...DOG,
      goodWith: { children: "Unknown", dogs: "Yes", cats: "Yes" },
    };
    const pair: BondedGroup = { members: [DOG, unrecorded] };
    expect(goodWithFor(pair, "children")).toBe("Unknown");
    expect(matches({ goodWith: ["children"] }, pair, NOW)).toBe(true);
  });

  it("combines both rules in one criteria set", () => {
    const waryPup: Animal = {
      ...pup("a"),
      goodWith: { children: "No", dogs: "Yes", cats: "Yes" },
    };
    const group: BondedGroup = { members: [mother, waryPup] };
    // The Adult is there, so the descriptive axis passes...
    expect(matches({ ageBands: ["Adult"] }, group, NOW)).toBe(true);
    // ...and the safety axis still fails the whole unit.
    expect(
      matches({ ageBands: ["Adult"], goodWith: ["children"] }, group, NOW),
    ).toBe(false);
  });
});

describe("goodWithFor", () => {
  it("takes the worst answer across the unit", () => {
    const cases: ReadonlyArray<readonly [readonly Tri[], Tri]> = [
      [["Yes", "Yes"], "Yes"],
      [["Yes", "Unknown"], "Unknown"],
      [["Unknown", "Unknown"], "Unknown"],
      [["Yes", "No"], "No"],
      [["Unknown", "No"], "No"],
      [["No", "No"], "No"],
    ];
    for (const [values, expected] of cases) {
      const [first, second] = values as readonly [Tri, Tri];
      const group: BondedGroup = {
        members: [
          { ...DOG, goodWith: goodWithAll(first) },
          { ...DOG, goodWith: goodWithAll(second) },
        ],
      };
      expect(goodWithFor(group, "dogs")).toBe(expected);
    }
  });

  it("is the animal's own answer for a lone animal", () => {
    const axis: GoodWithAxis = "cats";
    expect(goodWithFor(DOG, axis)).toBe("Yes");
  });
});

describe("ageBandsFor", () => {
  it("is one band for an animal and the distinct union for a group", () => {
    expect(ageBandsFor(DOG, NOW)).toEqual(["Young"]);
    const group: BondedGroup = {
      members: [
        { ...DOG, estimatedBirthDate: at("2026-03-07") },
        { ...DOG, estimatedBirthDate: at("2026-04-07") },
        { ...DOG, estimatedBirthDate: at("2021-09-07") },
      ],
    };
    expect(ageBandsFor(group, NOW)).toEqual(["Puppy", "Adult"]);
  });
});

describe("no band is ever accepted as input", () => {
  it("an Animal carries a date and has no band field", () => {
    const animal: Animal = {
      ...DOG,
      // @ts-expect-error — a stored band is exactly what ADR 0004 forbids. If this line
      // ever compiles, an animal has stopped graduating on its own.
      ageBand: "Puppy",
    };
    expect(animal.estimatedBirthDate).toBeInstanceOf(Date);
  });

  it("a group that falls below two members is not a group the type admits", () => {
    // @ts-expect-error — "a group that falls below two members dissolves" (CONTEXT.md).
    const dissolved: BondedGroup = { members: [DOG] };
    expect(dissolved.members).toHaveLength(1);
  });

  it("criteria hold bands, because a band is what a subscriber chose", () => {
    const criteria: SubscriptionCriteria = { ageBands: ["Puppy", "Kitten"] };
    expect(criteria.ageBands).toEqual(["Puppy", "Kitten"]);
  });
});
