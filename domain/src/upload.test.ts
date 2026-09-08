import { describe, expect, it } from "vitest";
import { DERIVATIVES } from "./derivative.ts";
import {
  ACCEPTED_ORIGINAL_TYPES,
  MAX_ORIGINAL_BYTES,
  MAX_ORIGINAL_DIMENSION,
  MAX_ORIGINAL_PIXELS,
  MAX_PHOTOS_PER_ANIMAL,
  MONTHLY_TRANSFORMATION_BUDGET,
  STORAGE_MEASUREMENT_MAX_AGE_MS,
  UPLOAD_SESSION_TTL_MS,
  type StorageMeasurement,
  type UploadPreflight,
  derivativesFor,
  deriveStorageMode,
  isAbandoned,
  isResumable,
  photoLimitFor,
  refuseImage,
  refuseUpload,
  transformationsFor,
  transformationsForAnimal,
} from "./upload.ts";

const NOW = new Date("2026-09-08T12:00:00Z");

/** A measurement taken an hour ago, well inside the platform's normal range. */
const HEALTHY: StorageMeasurement = {
  totalBytes: 1_000_000_000,
  measuredAt: new Date(NOW.getTime() - 60 * 60_000),
};

function preflight(overrides: Partial<UploadPreflight> = {}): UploadPreflight {
  return {
    contentType: "image/jpeg",
    declaredBytes: 2_000_000,
    sessionCreatedAt: new Date(NOW.getTime() - 60_000),
    photosInSession: 0,
    transformationsUsedThisMonth: 0,
    storage: HEALTHY,
    ...overrides,
  };
}

describe("derivativesFor", () => {
  it("gives the primary all four and every other photo the two shared ones", () => {
    expect(derivativesFor("primary").sort()).toEqual([
      "cardThumbnail",
      "detailImage",
      "digestThumbnail",
      "socialPreview",
    ]);
    expect(derivativesFor("additional").sort()).toEqual([
      "cardThumbnail",
      "detailImage",
    ]);
  });

  it("reads the split off DERIVATIVES rather than repeating it", () => {
    // The guard against the two drifting apart: if a derivative's `appliesTo` changes, this
    // assertion moves with it, and any hard-coded list here would not have.
    const primaryOnly = Object.keys(DERIVATIVES).filter(
      (name) =>
        DERIVATIVES[name as keyof typeof DERIVATIVES].appliesTo ===
        "primaryOnly",
    );
    for (const name of primaryOnly) {
      expect(derivativesFor("additional")).not.toContain(name);
      expect(derivativesFor("primary")).toContain(name);
    }
  });
});

describe("transformation cost", () => {
  it("is four for the primary and two for every other photo", () => {
    expect(transformationsFor("primary")).toBe(4);
    expect(transformationsFor("additional")).toBe(2);
  });

  it("sums to ADR 0012's 2N + 2 for a whole animal", () => {
    for (let photos = 1; photos <= MAX_PHOTOS_PER_ANIMAL; photos++) {
      expect(transformationsForAnimal(photos)).toBe(2 * photos + 2);
    }
    // The two endpoints the ADR quotes by name.
    expect(transformationsForAnimal(1)).toBe(4);
    expect(transformationsForAnimal(6)).toBe(14);
  });

  it("keeps a month's budget above ADR 0012's ~350 animals", () => {
    // The floor of the "~350-500 new animals per month" the ADR reasons from: a six-photo
    // animal is the worst case, and 5,000 / 14 is 357.
    expect(
      Math.floor(MONTHLY_TRANSFORMATION_BUDGET / transformationsForAnimal(6)),
    ).toBeGreaterThanOrEqual(350);
  });
});

describe("deriveStorageMode", () => {
  it("walks ADR 0012's ladder at its thresholds", () => {
    const at = (totalBytes: number) =>
      deriveStorageMode({ totalBytes, measuredAt: HEALTHY.measuredAt }, NOW);

    expect(at(5_999_999_999)).toBe("normal");
    expect(at(6_000_000_000)).toBe("alarming");
    expect(at(7_999_999_999)).toBe("alarming");
    expect(at(8_000_000_000)).toBe("degraded");
    expect(at(9_499_999_999)).toBe("degraded");
    expect(at(9_500_000_000)).toBe("refusing");
  });

  it("degrades when the sweep has never run", () => {
    // ADR 0016's cautious direction: no row means no measurement, not an empty platform.
    expect(deriveStorageMode(null, NOW)).toBe("degraded");
  });

  it("degrades at the moment the measurement goes stale, not before", () => {
    const justInside = new Date(
      NOW.getTime() - STORAGE_MEASUREMENT_MAX_AGE_MS,
    );
    const justOutside = new Date(justInside.getTime() - 1);

    expect(
      deriveStorageMode({ totalBytes: 0, measuredAt: justInside }, NOW),
    ).toBe("normal");
    expect(
      deriveStorageMode({ totalBytes: 0, measuredAt: justOutside }, NOW),
    ).toBe("degraded");
  });

  it("degrades on a stale measurement even when that measurement said the platform was empty", () => {
    // The failure this exists for: a dead sweep leaves a reassuring number behind.
    expect(
      deriveStorageMode(
        {
          totalBytes: 0,
          measuredAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
        },
        NOW,
      ),
    ).toBe("degraded");
  });
});

describe("photoLimitFor", () => {
  it("is six normally, one degraded and none refusing", () => {
    expect(photoLimitFor("normal")).toBe(6);
    expect(photoLimitFor("alarming")).toBe(6);
    expect(photoLimitFor("degraded")).toBe(1);
    expect(photoLimitFor("refusing")).toBe(0);
  });
});

describe("refuseUpload", () => {
  it("accepts an ordinary first photo", () => {
    expect(refuseUpload(preflight(), NOW)).toBeNull();
  });

  it("refuses a session at exactly 24 hours old", () => {
    const expired = preflight({
      sessionCreatedAt: new Date(NOW.getTime() - UPLOAD_SESSION_TTL_MS),
    });
    const alive = preflight({
      sessionCreatedAt: new Date(NOW.getTime() - UPLOAD_SESSION_TTL_MS + 1),
    });

    expect(refuseUpload(expired, NOW)?.reason).toBe("session-expired");
    expect(refuseUpload(alive, NOW)).toBeNull();
  });

  it("refuses a seventh photo", () => {
    expect(refuseUpload(preflight({ photosInSession: 5 }), NOW)).toBeNull();
    expect(refuseUpload(preflight({ photosInSession: 6 }), NOW)).toEqual({
      reason: "photo-limit-reached",
      limit: 6,
      actual: 6,
    });
  });

  it("refuses a second photo while storage is degraded", () => {
    const degraded = preflight({
      photosInSession: 1,
      storage: { totalBytes: 8_500_000_000, measuredAt: HEALTHY.measuredAt },
    });
    // The first photo still goes through — that is what "degrade rather than refuse" means.
    expect(refuseUpload({ ...degraded, photosInSession: 0 }, NOW)).toBeNull();
    expect(refuseUpload(degraded, NOW)?.reason).toBe("photo-limit-reached");
    expect(refuseUpload(degraded, NOW)?.limit).toBe(1);
  });

  it("refuses everything once storage is exhausted", () => {
    const full = preflight({
      photosInSession: 0,
      storage: { totalBytes: 9_600_000_000, measuredAt: HEALTHY.measuredAt },
    });
    expect(refuseUpload(full, NOW)?.reason).toBe("storage-exhausted");
  });

  it("refuses a type the image pipeline was never promised", () => {
    expect(refuseUpload(preflight({ contentType: "image/gif" }), NOW)?.reason).toBe(
      "unsupported-type",
    );
    expect(
      refuseUpload(preflight({ contentType: "application/pdf" }), NOW)?.reason,
    ).toBe("unsupported-type");
    for (const contentType of ACCEPTED_ORIGINAL_TYPES) {
      expect(refuseUpload(preflight({ contentType }), NOW)).toBeNull();
    }
  });

  it("refuses a file over 12 MB on its declared length alone", () => {
    expect(
      refuseUpload(preflight({ declaredBytes: MAX_ORIGINAL_BYTES }), NOW),
    ).toBeNull();
    expect(
      refuseUpload(preflight({ declaredBytes: MAX_ORIGINAL_BYTES + 1 }), NOW),
    ).toEqual({
      reason: "file-too-large",
      limit: MAX_ORIGINAL_BYTES,
      actual: MAX_ORIGINAL_BYTES + 1,
    });
  });

  it("does not treat a missing length as a size refusal", () => {
    // There is no size to judge. The route refuses such a body with 411 for an unrelated
    // reason — R2 will not take a stream of unknown length — and reporting it as
    // `file-too-large` here would send a shelter off to shrink a file that was fine.
    expect(refuseUpload(preflight({ declaredBytes: null }), NOW)).toBeNull();
  });

  it("refuses a primary that does not fit in the month's remaining transformations", () => {
    const fits = preflight({
      photosInSession: 0,
      transformationsUsedThisMonth: MONTHLY_TRANSFORMATION_BUDGET - 4,
    });
    const does_not = preflight({
      photosInSession: 0,
      transformationsUsedThisMonth: MONTHLY_TRANSFORMATION_BUDGET - 3,
    });

    expect(refuseUpload(fits, NOW)).toBeNull();
    expect(refuseUpload(does_not, NOW)?.reason).toBe(
      "transformation-budget-exhausted",
    );
  });

  it("charges an additional photo two rather than four", () => {
    // Three left is not enough for a primary and is enough for the fifth photo of an
    // animal, which is the whole reason the cost depends on the role.
    const three_left = preflight({
      photosInSession: 4,
      transformationsUsedThisMonth: MONTHLY_TRANSFORMATION_BUDGET - 3,
    });
    expect(refuseUpload(three_left, NOW)).toBeNull();
    expect(
      refuseUpload({ ...three_left, photosInSession: 0 }, NOW)?.reason,
    ).toBe("transformation-budget-exhausted");
  });

  it("reports the photo limit before judging the file, so a refused photo is not re-exported for nothing", () => {
    const seventh_and_huge = preflight({
      photosInSession: 6,
      declaredBytes: 50_000_000,
      contentType: "application/pdf",
    });
    expect(refuseUpload(seventh_and_huge, NOW)?.reason).toBe(
      "photo-limit-reached",
    );
  });

  it("reports the expired session ahead of everything else", () => {
    const everything_wrong = preflight({
      sessionCreatedAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
      photosInSession: 9,
      contentType: "application/pdf",
      declaredBytes: 50_000_000,
      transformationsUsedThisMonth: MONTHLY_TRANSFORMATION_BUDGET,
      storage: null,
    });
    expect(refuseUpload(everything_wrong, NOW)?.reason).toBe("session-expired");
  });
});

describe("refuseImage", () => {
  it("accepts what a phone actually takes", () => {
    // A 48-megapixel iPhone frame, and a 12-megapixel one.
    expect(refuseImage({ width: 8064, height: 6048 })).toBeNull();
    expect(refuseImage({ width: 4032, height: 3024 })).toBeNull();
  });

  it("refuses beyond the pipeline's own dimension ceiling, on either side", () => {
    expect(
      refuseImage({ width: MAX_ORIGINAL_DIMENSION, height: 100 }),
    ).toBeNull();
    expect(
      refuseImage({ width: MAX_ORIGINAL_DIMENSION + 1, height: 100 })?.reason,
    ).toBe("image-too-large");
    expect(
      refuseImage({ width: 100, height: MAX_ORIGINAL_DIMENSION + 1 })?.reason,
    ).toBe("image-too-large");
  });

  it("refuses beyond the pipeline's area ceiling even where neither side is over", () => {
    // 11,000 x 11,000 is inside the dimension limit on both sides and 121 megapixels.
    const square = { width: 11_000, height: 11_000 };
    expect(Math.max(square.width, square.height)).toBeLessThanOrEqual(
      MAX_ORIGINAL_DIMENSION,
    );
    expect(square.width * square.height).toBeGreaterThan(MAX_ORIGINAL_PIXELS);
    expect(refuseImage(square)).toEqual({
      reason: "image-too-large",
      limit: MAX_ORIGINAL_PIXELS,
      actual: square.width * square.height,
    });
  });

  it("judges dimensions and nothing else", () => {
    // The byte cap is `refuseUpload`'s, decided before the body is touched, and then held to
    // by the stream itself. Judging it here as well would be a second answer to a question
    // that already has one.
    expect(refuseImage({ width: 100, height: 100 })).toBeNull();
  });
});

describe("upload session lifetime", () => {
  const fresh = { createdAt: new Date(NOW.getTime() - 60_000), hasCommittedAnimal: false };
  const old = {
    createdAt: new Date(NOW.getTime() - UPLOAD_SESSION_TTL_MS),
    hasCommittedAnimal: false,
  };

  it("is resumable for a day and abandoned after it", () => {
    expect(isResumable(fresh, NOW)).toBe(true);
    expect(isAbandoned(fresh, NOW)).toBe(false);

    expect(isResumable(old, NOW)).toBe(false);
    expect(isAbandoned(old, NOW)).toBe(true);
  });

  it("holds resumable and abandoned as exact opposites for an uncommitted session", () => {
    // One expression, two names — so the 24-hour boundary cannot be off by one on one side
    // and not the other, which would either strand objects or delete a live session's.
    for (const age of [0, 1, UPLOAD_SESSION_TTL_MS - 1, UPLOAD_SESSION_TTL_MS, UPLOAD_SESSION_TTL_MS + 1]) {
      const session = {
        createdAt: new Date(NOW.getTime() - age),
        hasCommittedAnimal: false,
      };
      expect(isAbandoned(session, NOW)).toBe(!isResumable(session, NOW));
    }
  });

  it("never abandons a session that produced an animal, however old", () => {
    // Its photos belong to the animal now, and the animal is what references them.
    expect(
      isAbandoned(
        {
          createdAt: new Date(NOW.getTime() - 365 * 24 * 60 * 60_000),
          hasCommittedAnimal: true,
        },
        NOW,
      ),
    ).toBe(false);
  });
});
