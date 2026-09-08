import { describe, expect, it } from "vitest";
import {
  AGE_ESTIMATE_BASES,
  type AnimalDraftFacts,
  MAX_URGENT_PER_SHELTER,
  STERILISATIONS,
  isAgeEstimateBasis,
  isSterilisation,
  refuseAnimal,
  refuseUrgency,
} from "./animal.ts";
import {
  GOOD_WITH_FLAGS,
  SEXES,
  SIZES,
  SPECIES,
  type Size,
  isGoodWithFlag,
  isSex,
  isSize,
  isSpecies,
  sizeApplies,
} from "./axes.ts";
import { AVAILABILITIES, isAvailability } from "./listing.ts";
import { MAX_PHOTOS_PER_ANIMAL, MIN_PHOTOS_PER_ANIMAL } from "./upload.ts";

/**
 * A publishable dog, which every case below varies one fact of. Six photos and a size,
 * because those are the two facts `refuseAnimal` judges and a base case that already
 * satisfies both makes each test's single change the whole of what it is testing.
 */
const A_DOG: AnimalDraftFacts = { species: "dog", size: "Medium", photoCount: 3 };

describe("the closed vocabularies", () => {
  /**
   * The whole point of the guards, and the reason each list is data rather than only a type.
   *
   * `CONTEXT.md` makes every axis vocabulary platform-owned "and never extended by a
   * shelter", and the cost of letting one through is not a validation message: a
   * shelter-invented value matches no subscription, so it silently costs the shelter the
   * reach it was publishing for. Each axis is checked against a value that is *plausible*
   * rather than gibberish — `"Other"`, `"Bird"`, `"Maybe"` — because those are what a
   * hand-made request or a future careless form would actually send.
   */
  const cases = [
    { axis: "species", guard: isSpecies, accepts: SPECIES, rejects: ["Bird", "dogs", "Dog", ""] },
    { axis: "sex", guard: isSex, accepts: SEXES, rejects: ["male", "Other", "Intersex", ""] },
    { axis: "size", guard: isSize, accepts: SIZES, rejects: ["small", "Tiny", "XL", ""] },
    {
      axis: "good-with flag",
      guard: isGoodWithFlag,
      accepts: GOOD_WITH_FLAGS,
      rejects: ["yes", "Maybe", "Sometimes", ""],
    },
    {
      axis: "availability",
      guard: isAvailability,
      accepts: AVAILABILITIES,
      rejects: ["Draft", "Stale", "Archived", "available", ""],
    },
    {
      axis: "age-estimate basis",
      guard: isAgeEstimateBasis,
      accepts: AGE_ESTIMATE_BASES,
      rejects: ["Guess", "Unknown", "documented", ""],
    },
    {
      axis: "sterilisation",
      guard: isSterilisation,
      // `true` and `false` are the rejects that matter: they are what a form built against
      // the boolean this attribute is *not* would send.
      accepts: STERILISATIONS,
      rejects: ["true", "false", "Neutered", "Spayed", "sterilised", ""],
    },
  ] as const;

  for (const { axis, guard, accepts, rejects } of cases) {
    it(`accepts every ${axis} the platform owns and nothing else`, () => {
      for (const value of accepts) expect(guard(value)).toBe(true);
      for (const value of rejects) expect(guard(value)).toBe(false);
    });
  }

  it("closes species at two, with no Other", () => {
    // The absence is the decision: `CONTEXT.md` writes the axis as `Dog | Cat` closed, and
    // an `Other` member would be a value no subscription could usefully match.
    expect(SPECIES).toEqual(["dog", "cat"]);
  });

  it("closes availability at three, with no Draft and no Stale", () => {
    expect(AVAILABILITIES).toHaveLength(3);
    expect(AVAILABILITIES as readonly string[]).not.toContain("Draft");
    expect(AVAILABILITIES as readonly string[]).not.toContain("Stale");
  });

  it("lets a shelter say it does not know whether an animal is sterilised", () => {
    // The third value is the reason this is not a boolean: a shelter that took a dog in last
    // week has no answer, and being made to pick one stores a guess as a fact.
    expect(STERILISATIONS).toHaveLength(3);
    expect(STERILISATIONS as readonly string[]).toContain("Unknown");
  });

  it("offers not-known on every good-with axis", () => {
    // A shelter has to be able to answer "not known" at all, or it learns that claiming
    // `Yes` is the price of being seen.
    expect(GOOD_WITH_FLAGS as readonly string[]).toContain("Unknown");
  });
});

describe("sizeApplies", () => {
  it("asks size of dogs and not of cats", () => {
    expect(sizeApplies("dog")).toBe(true);
    expect(sizeApplies("cat")).toBe(false);
  });
});

describe("refuseAnimal", () => {
  it("publishes an animal that satisfies both invariants", () => {
    expect(refuseAnimal(A_DOG)).toBeNull();
  });

  describe("the photo-count invariant", () => {
    it("refuses an animal with no photos at all", () => {
      // The case an `isPrimary` column would have let through, and the reason the invariant
      // is enforced at creation: an animal with no photos has no primary photo, so every
      // single-image surface would have nothing to show.
      const refusal = refuseAnimal({ ...A_DOG, photoCount: 0 });
      expect(refusal).toEqual({
        reason: "photo-count",
        limit: MIN_PHOTOS_PER_ANIMAL,
        actual: 0,
      });
    });

    it("refuses a seventh photo", () => {
      const refusal = refuseAnimal({
        ...A_DOG,
        photoCount: MAX_PHOTOS_PER_ANIMAL + 1,
      });
      expect(refusal).toEqual({
        reason: "photo-count",
        limit: MAX_PHOTOS_PER_ANIMAL,
        actual: MAX_PHOTOS_PER_ANIMAL + 1,
      });
    });

    it("accepts every count from one to six", () => {
      for (
        let count = MIN_PHOTOS_PER_ANIMAL;
        count <= MAX_PHOTOS_PER_ANIMAL;
        count++
      ) {
        expect(refuseAnimal({ ...A_DOG, photoCount: count })).toBeNull();
      }
    });

    it("reports the photo count before a missing size", () => {
      // Order is part of the answer: the shelter has been uploading, and being told about
      // its size field before being told the upload did not take sends it to fix the wrong
      // thing.
      const refusal = refuseAnimal({ species: "dog", size: null, photoCount: 0 });
      expect(refusal?.reason).toBe("photo-count");
    });
  });

  describe("the size axis", () => {
    it("requires a size of a dog", () => {
      expect(refuseAnimal({ ...A_DOG, size: null })).toEqual({
        reason: "size-required",
      });
    });

    it("refuses a size on a cat", () => {
      // Not merely unasked but unanswerable: the bands are dog weight classes.
      expect(refuseAnimal({ species: "cat", size: "Small", photoCount: 1 })).toEqual({
        reason: "size-not-applicable",
      });
    });

    it("publishes a cat with no size", () => {
      expect(
        refuseAnimal({ species: "cat", size: null, photoCount: 1 }),
      ).toBeNull();
    });

    it("accepts every size on a dog", () => {
      for (const size of SIZES) {
        expect(refuseAnimal({ ...A_DOG, size })).toBeNull();
      }
    });

    it("refuses every size on a cat", () => {
      for (const size of SIZES) {
        expect(
          refuseAnimal({ species: "cat", size, photoCount: 1 })?.reason,
        ).toBe("size-not-applicable");
      }
    });

    it("judges the pairing through sizeApplies rather than a second copy of the rule", () => {
      // A third species argued for later must get its answer from one place. If
      // `sizeApplies` ever says a cat has a size, this rule has to follow it — so the two
      // are asserted to agree rather than trusted to.
      for (const species of SPECIES) {
        const withSize = refuseAnimal({
          species,
          size: "Medium" satisfies Size,
          photoCount: 1,
        });
        const without = refuseAnimal({ species, size: null, photoCount: 1 });
        expect(withSize === null).toBe(sizeApplies(species));
        expect(without === null).toBe(!sizeApplies(species));
      }
    });
  });
});

describe("refuseUrgency", () => {
  it("sets a mark that carries a reason and fits under the cap", () => {
    expect(
      refuseUrgency({ reason: "Necesita cirugía esta semana.", otherUrgentCount: 0 }),
    ).toBeNull();
  });

  it("refuses a mark with nothing written in it", () => {
    // An urgency mark with no reason is a claim an adopter cannot weigh. `CONTEXT.md`
    // builds the reason into the definition, so a mark without one is not a mark.
    expect(refuseUrgency({ reason: "", otherUrgentCount: 0 })).toEqual({
      reason: "urgency-reason-missing",
    });
  });

  it("reports the missing reason before the cap", () => {
    // A shelter at the cap that also wrote nothing is told about the reason first: it is the
    // half it can fix on this form.
    expect(
      refuseUrgency({ reason: "", otherUrgentCount: MAX_URGENT_PER_SHELTER }),
    ).toEqual({ reason: "urgency-reason-missing" });
  });

  it("refuses a fourth concurrent mark", () => {
    expect(
      refuseUrgency({
        reason: "Necesita cirugía esta semana.",
        otherUrgentCount: MAX_URGENT_PER_SHELTER,
      }),
    ).toEqual({
      reason: "urgency-cap-reached",
      limit: MAX_URGENT_PER_SHELTER,
      actual: MAX_URGENT_PER_SHELTER,
    });
  });

  it("allows exactly three at once and no more", () => {
    const reason = "Necesita cirugía esta semana.";
    for (let held = 0; held < MAX_URGENT_PER_SHELTER; held++) {
      expect(refuseUrgency({ reason, otherUrgentCount: held })).toBeNull();
    }
    expect(
      refuseUrgency({ reason, otherUrgentCount: MAX_URGENT_PER_SHELTER })?.reason,
    ).toBe("urgency-cap-reached");
  });

  it("counts other animals, so re-saving an already-marked animal is not refused by its own mark", () => {
    // The bug the obvious count produces: an edit that only rewords the reason on a
    // shelter's third urgent animal would read three marks and refuse a change that adds
    // none. `otherUrgentCount` excludes this animal, so two others is still under the cap.
    expect(
      refuseUrgency({
        reason: "Ahora con fecha de cirugía.",
        otherUrgentCount: MAX_URGENT_PER_SHELTER - 1,
      }),
    ).toBeNull();
  });
});
