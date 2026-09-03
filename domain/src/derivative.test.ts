import { describe, expect, it } from "vitest";
import { DERIVATIVES, transformationCost } from "./derivative.ts";
import { digestIdempotencyKey, DIGEST_DAILY_BUDGET } from "./digest.ts";

describe("the derivative set", () => {
  it("sends the digest thumbnail as JPEG, because Gmail transcodes WebP anyway", () => {
    expect(DERIVATIVES.digestThumbnail.format).toBe("jpeg");
    expect(DERIVATIVES.socialPreview.format).toBe("jpeg");
  });

  it("crops only the two fixed-aspect derivatives, and crops them saliently", () => {
    const cropping = Object.values(DERIVATIVES).filter((d) => d.fit === "cover");
    expect(cropping).toHaveLength(2);
    for (const spec of cropping) {
      expect(spec.gravity).toBe("auto");
      expect(spec.height).toBeDefined();
    }
  });

  it("generates the card thumbnail for every photo, not just the primary", () => {
    // Otherwise a six-photo gallery strip has nothing small to show and must pull six
    // detail images on a metered connection.
    expect(DERIVATIVES.cardThumbnail.appliesTo).toBe("everyPhoto");
    expect(DERIVATIVES.detailImage.appliesTo).toBe("everyPhoto");
    expect(DERIVATIVES.digestThumbnail.appliesTo).toBe("primaryOnly");
  });

  it("keeps 1280px as the master, since nothing larger can ever be backfilled", () => {
    const widest = Math.max(
      ...Object.values(DERIVATIVES)
        .filter((d) => d.fit === "scale-down")
        .map((d) => d.width),
    );
    expect(DERIVATIVES.detailImage.width).toBe(widest);
  });
});

describe("transformationCost", () => {
  it("is 2N + 2 — four at one photo, fourteen at six", () => {
    expect(transformationCost(1)).toBe(4);
    expect(transformationCost(6)).toBe(14);
  });

  it("puts the 5,000/month ceiling at roughly 350–500 new animals", () => {
    expect(Math.floor(5000 / transformationCost(6))).toBe(357);
    expect(Math.floor(5000 / transformationCost(1))).toBe(1250);
  });
});

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
