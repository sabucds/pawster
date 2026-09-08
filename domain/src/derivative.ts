/**
 * The fixed derivative set of
 * [ADR 0012](../../docs/adr/0012-derivatives-are-generated-once-at-upload.md). Four
 * derivatives because four consumers have genuinely different budgets, generated exactly
 * once at upload and never at read time.
 *
 * These are specs, not calls: pure data describing what to ask the image pipeline for.
 * The fetch that carries them lives in `web/`, because issuing it is I/O and this package
 * has none.
 */

export type DerivativeName =
  | "digestThumbnail"
  | "cardThumbnail"
  | "detailImage"
  | "socialPreview";

export interface DerivativeSpec {
  /**
   * Passed through to `cf.image` as-is. Both are always set, and for a `scale-down`
   * derivative they are set to the *same* number on purpose: ADR 0012 specifies each size
   * as a **long edge**, and `scale-down` fits the image inside the box it is given without
   * changing the aspect ratio. Giving it a square box is what turns "1280" into "1280px on
   * the longer side" for a portrait photo as well as a landscape one — a `width` alone
   * bounds only the width, and a portrait photo would come back taller than its budget.
   */
  readonly width: number;
  readonly height: number;
  readonly fit: "cover" | "scale-down";
  readonly format: "jpeg" | "webp";
  /**
   * Saliency-aware cropping, confirmed available on the Free plan and on both transform
   * forms (issue #34). Only meaningful where `fit` is `cover`.
   */
  readonly gravity?: "auto";
  /** Whether every photo gets one, or only the animal's primary photo. */
  readonly appliesTo: "everyPhoto" | "primaryOnly";
}

export const DERIVATIVES: Readonly<Record<DerivativeName, DerivativeSpec>> = {
  /**
   * JPEG, and this is not a detail: Outlook's Word rendering engine does not render WebP
   * at all, and Gmail transcodes it to JPEG itself — a transcode we neither control nor
   * measure is worse than sending the format the client wants.
   */
  digestThumbnail: {
    width: 144,
    height: 144,
    fit: "cover",
    gravity: "auto",
    format: "jpeg",
    appliesTo: "primaryOnly",
  },
  /** Generated for every photo, so a six-photo gallery strip has something small to show. */
  cardThumbnail: {
    width: 400,
    height: 400,
    fit: "scale-down",
    format: "webp",
    appliesTo: "everyPhoto",
  },
  /**
   * Our master, and a one-way door: every future derivative must be derivable from it,
   * because the originals are discarded. 1280 is mobile-first — a 390px viewport at DPR 3.
   */
  detailImage: {
    width: 1280,
    height: 1280,
    fit: "scale-down",
    format: "webp",
    appliesTo: "everyPhoto",
  },
  socialPreview: {
    width: 1200,
    height: 630,
    fit: "cover",
    gravity: "auto",
    format: "jpeg",
    appliesTo: "primaryOnly",
  },
};

/**
 * The prefix every derivative object lives under in `pawster-media`, and reclamation's
 * entire scope.
 *
 * [ADR 0016](../../docs/adr/0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md)
 * makes the nightly sweep list `d/` and never the bucket root, so that anything added to
 * the bucket later — the filter index under `i/`, whatever comes after it — is invisible to
 * reclamation until it is deliberately opted in. A denylist would have deleted every one of
 * them by default.
 */
export const DERIVATIVE_PREFIX = "d/";

/**
 * The file extension each output format is stored under. Cosmetic to R2, which is
 * indifferent to a key's shape, and not cosmetic to a human reading a bucket listing or a
 * browser handed the URL directly.
 */
const EXTENSIONS: Readonly<Record<DerivativeSpec["format"], string>> = {
  jpeg: "jpg",
  webp: "webp",
};

/**
 * A derivative spec as a short, stable string — the "plus the derivative spec" half of
 * ADR 0012's content-addressed key.
 *
 * It has to cover **every** field that changes the bytes, or two different derivatives of
 * one photo would collide on one key and the second would silently serve the first. Reading
 * the fields off the spec rather than hard-coding a string per derivative is what keeps that
 * true when a spec is edited: change 1280 to 1600 and every key changes with it, which is
 * the correct behaviour — a new spec is a new object, not an overwrite of an immutable one.
 *
 * The name is *not* in the fingerprint, on purpose. Two derivatives that asked for
 * identical bytes should be one object; naming them apart would store the same image twice.
 */
export function derivativeSpecFingerprint(name: DerivativeName): string {
  const spec = DERIVATIVES[name];
  return [
    spec.width,
    spec.height,
    spec.fit,
    spec.format,
    spec.gravity ?? "none",
  ].join("-");
}

/**
 * What a derivative's key is hashed over: the source bytes' digest, then the spec.
 *
 * Returned as material for the caller to hash rather than hashed here, because hashing is
 * `crypto.subtle` and this package holds no I/O and no globals it did not import — see
 * `docs/testing-seams.md` on why `domain/` is the one workspace that needs neither seam.
 * `web/src/lib/media/keys.ts` does the hashing.
 *
 * The separator matters more than it looks: without it, a digest ending in `1` followed by
 * a fingerprint starting `44x144...` would be the same string as a different digest and a
 * different fingerprint. `:` cannot occur in either half — one is hex, the other is built
 * from the fixed vocabulary above.
 */
export function derivativeKeyMaterial(
  sourceDigest: string,
  name: DerivativeName,
): string {
  return `${sourceDigest}:${derivativeSpecFingerprint(name)}`;
}

/**
 * The object key for a derivative whose key material has been hashed.
 *
 * Immutable and opaque, which is what makes ADR 0007's regenerate-the-index-on-publish safe
 * rather than racy and what removes cache purging from the publish path entirely: an
 * adopter reading mid-write gets a coherent *old* index, never a new one pointing at an
 * object that does not exist yet.
 *
 * The consequence is the one ADR 0016 is about: two animals photographed in one shot share
 * one object, so "this key is dead" is never a fact about a key.
 */
export function derivativeKeyFor(
  keyDigest: string,
  name: DerivativeName,
): string {
  return `${DERIVATIVE_PREFIX}${keyDigest}.${EXTENSIONS[DERIVATIVES[name].format]}`;
}

/**
 * What a derivative is served as: the format's media type, and `immutable` forever.
 *
 * A year is the longest `max-age` any cache is required to honour, and `immutable` is what
 * tells a revalidating browser not to bother asking. Both are safe to the point of being
 * uninteresting *because* the key is the content — the bytes behind this key cannot change,
 * so there is nothing a stale cache could be stale about.
 */
export const DERIVATIVE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The media type a derivative is stored and served with. */
export function derivativeContentType(name: DerivativeName): string {
  return `image/${DERIVATIVES[name].format}`;
}

