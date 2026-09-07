import { describe, expect, it } from "vitest";
import { DERIVATIVES } from "./derivative.ts";

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
    }
  });

  it("bounds the long edge, not the width, on every uncropped derivative", () => {
    // ADR 0012 specifies each size as a long edge. `scale-down` fits the image inside the
    // box without changing its aspect ratio, so a square box is what makes the bound apply
    // to a portrait photo too — with `width` alone, a 3:4 photo at width 400 comes back 533
    // tall and over budget.
    for (const spec of Object.values(DERIVATIVES)) {
      if (spec.fit !== "scale-down") continue;
      expect(spec.height).toBe(spec.width);
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
