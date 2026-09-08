import { describe, expect, it } from "vitest";
import {
  DERIVATIVE_CACHE_CONTROL,
  DERIVATIVE_PREFIX,
  DERIVATIVES,
  type DerivativeName,
  derivativeContentType,
  derivativeKeyFor,
  derivativeKeyMaterial,
  derivativeSpecFingerprint,
} from "./derivative.ts";

const NAMES = Object.keys(DERIVATIVES) as DerivativeName[];

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

describe("derivative keys", () => {
  const DIGEST_A = "a".repeat(64);
  const DIGEST_B = "b".repeat(64);

  it("gives every derivative of one photo a different key", () => {
    // The collision that would matter: two specs sharing a key means the second derivative
    // silently serves the first one's bytes, at a size nothing asked for.
    const materials = NAMES.map((name) => derivativeKeyMaterial(DIGEST_A, name));
    expect(new Set(materials).size).toBe(NAMES.length);
  });

  it("gives identical bytes under one spec identical key material", () => {
    // ADR 0016's shared-key case: two animals photographed in one shot are one object.
    expect(derivativeKeyMaterial(DIGEST_A, "cardThumbnail")).toBe(
      derivativeKeyMaterial(DIGEST_A, "cardThumbnail"),
    );
    expect(derivativeKeyMaterial(DIGEST_A, "cardThumbnail")).not.toBe(
      derivativeKeyMaterial(DIGEST_B, "cardThumbnail"),
    );
  });

  it("covers every field of the spec that changes the bytes", () => {
    // Read off the spec rather than asserted as a literal, so editing a spec moves this.
    for (const name of NAMES) {
      const spec = DERIVATIVES[name];
      const fingerprint = derivativeSpecFingerprint(name);
      expect(fingerprint).toContain(String(spec.width));
      expect(fingerprint).toContain(String(spec.height));
      expect(fingerprint).toContain(spec.fit);
      expect(fingerprint).toContain(spec.format);
      expect(fingerprint).toContain(spec.gravity ?? "none");
    }
  });

  it("separates the digest from the fingerprint so neither can run into the other", () => {
    // Without a separator, digest `…1` + fingerprint `44x144-…` and digest `…144` +
    // fingerprint `x144-…` would be the same string.
    expect(derivativeKeyMaterial(DIGEST_A, "digestThumbnail")).toBe(
      `${DIGEST_A}:${derivativeSpecFingerprint("digestThumbnail")}`,
    );
  });

  it("puts every key under d/, which is reclamation's entire scope", () => {
    for (const name of NAMES) {
      expect(derivativeKeyFor("f".repeat(64), name)).toMatch(
        new RegExp(`^${DERIVATIVE_PREFIX}`),
      );
    }
  });

  it("names the file after the format it actually holds", () => {
    expect(derivativeKeyFor(DIGEST_A, "digestThumbnail")).toBe(
      `d/${DIGEST_A}.jpg`,
    );
    expect(derivativeKeyFor(DIGEST_A, "detailImage")).toBe(`d/${DIGEST_A}.webp`);
    expect(derivativeContentType("digestThumbnail")).toBe("image/jpeg");
    expect(derivativeContentType("detailImage")).toBe("image/webp");
  });

  it("serves derivatives as immutable, because the key is the content", () => {
    expect(DERIVATIVE_CACHE_CONTROL).toContain("immutable");
    // A year is the longest any cache is required to honour; there is nothing to revalidate.
    expect(DERIVATIVE_CACHE_CONTROL).toContain("max-age=31536000");
  });
});
