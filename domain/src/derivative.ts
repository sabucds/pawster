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
  /** Passed through to `cf.image` as-is. */
  readonly width: number;
  readonly height?: number;
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
 * Transformations an animal with `photoCount` photos costs, against the 5,000/month
 * account-wide ceiling: `2N + 2`, so 4 at one photo and 14 at six. The upload path checks
 * the remaining budget *before accepting any bytes*, because exhaustion (error 9422) fails
 * closed mid-upload and the `onerror` fallback does not apply.
 */
export function transformationCost(photoCount: number): number {
  return 2 * photoCount + 2;
}
