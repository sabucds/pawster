/**
 * The numbers and verdicts of the photo pipeline, with no I/O and no clock of its own.
 *
 * Every rule here is a refusal that has to happen **before any bytes are stored**, which is
 * the whole reason they are pure: a decision taken before the write can be table-tested
 * without a bucket, a transform or a shelter, and a decision taken after it cannot be taken
 * at all. [ADR 0012](../../docs/adr/0012-derivatives-are-generated-once-at-upload.md) is
 * blunt about why the three caps exist — "the caps are ours, because R2 bills instead of
 * failing" — and about the failure they prevent: a shelter left holding a half-built animal.
 *
 * This is in `domain/` rather than in `web/` because two consumers need it, which is the
 * bar `web/src/lib/auth/policy.ts` sets for itself and does not meet. The upload path in
 * `web/` reads these to refuse, and the nightly reclamation sweep in `digest/`
 * ([ADR 0016](../../docs/adr/0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md),
 * issue #66) reads {@link isAbandoned} and {@link UPLOAD_SESSION_TTL_MS} to decide which
 * sessions still hold a reference. Two Workers, one set of numbers.
 */

import { DERIVATIVES, type DerivativeName } from "./derivative.ts";

/**
 * An animal carries between one and six photos, first primary — enforced as a
 * creation-time invariant rather than as a `Draft` state (ADR 0012). The session is where
 * the invariant is *assembled*; the animal row that references it is written last, by
 * issue #55.
 */
export const MIN_PHOTOS_PER_ANIMAL = 1;
export const MAX_PHOTOS_PER_ANIMAL = 6;

/**
 * The largest original the platform accepts, in bytes.
 *
 * ADR 0012's figure, and the reason it is ours rather than a vendor's is stated there:
 * "R2 will happily accept a 5 TiB object". Nothing downstream refuses a huge upload, so
 * this is the only place it can be refused. It sits below the image pipeline's own 20 MB
 * input ceiling on purpose — a file that clears this cap and then fails the transform has
 * already cost us the bytes.
 */
export const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024;

/**
 * The pipeline's own documented input ceilings, restated here as *our* pre-store refusal.
 *
 * These two are Cloudflare's published limits on an image transformation's input — 12,000
 * pixels on a side, 100 megapixels of area — not a measurement of ours, and they are
 * written down here for a reason that has nothing to do with taste: an image beyond them
 * fails the transform, and the transform happens **after** the original is stored. Left
 * unchecked, the shelter's failure mode is a stored original, a spent request and no
 * derivatives — the exact half-built state ADR 0012 exists to prevent. Checking the header
 * first converts it into a refusal the shelter can act on.
 *
 * A phone camera is nowhere near either: a 48-megapixel iPhone frame is 8064x6048, which
 * is 8,064 on its longest side and 48.8 megapixels. What trips these is a scan, a panorama
 * stitch or a screenshot of a screenshot.
 */
export const MAX_ORIGINAL_DIMENSION = 12_000;
export const MAX_ORIGINAL_PIXELS = 100_000_000;

/**
 * What the platform will accept a photo *as*.
 *
 * Four types, and the list is short deliberately. JPEG, PNG and WebP are what a laptop
 * produces; HEIC/HEIF is what an iPhone shoots by default, and ADR 0012 turns on
 * Cloudflare accepting it on the Free plan — it is the single input the rejected
 * resize-in-the-browser option could not decode at all.
 *
 * **GIF is deliberately absent.** Cloudflare would accept it, but every derivative in
 * {@link DERIVATIVES} is a still JPEG or WebP, so an animated GIF would publish as one
 * frame with no error anywhere — the shelter would see its animation silently gone. A
 * refusal it can read beats a success it was not promised.
 *
 * `image/heic` and `image/heif` are both listed because the two are used interchangeably
 * by exporters, and a shelter has no way to influence which one its phone sends.
 */
export const ACCEPTED_ORIGINAL_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

/**
 * How long a shelter may come back to a session, and the same 24 hours after which the
 * sweep considers it abandoned. One constant, because two would eventually disagree and
 * the disagreement would either strand objects forever or delete a session a shelter was
 * still using.
 *
 * ADR 0012: "losing five successful uploads to one dropped connection is the failure this
 * platform can least afford."
 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60_000;

/**
 * Cloudflare's monthly ceiling on unique image transformations, and so the platform's
 * ceiling on new photos: ADR 0012 puts it at "~350-500 new animals per month, recurring".
 *
 * Exhaustion returns error 9422 **mid-upload**, which is why this is checked before any
 * bytes are accepted rather than handled when it happens: the shelter's half of a failure
 * at that point is an animal it cannot finish.
 */
export const MONTHLY_TRANSFORMATION_BUDGET = 5_000;

/**
 * The first instant of the calendar month `now` falls in, UTC — the boundary the budget
 * above resets on.
 *
 * Here rather than beside the query that uses it, because it is calendar policy and not a
 * query: it decides *which* month a spend belongs to, and getting it wrong shifts the
 * platform's ceiling rather than mis-shaping a `SELECT`. Cloudflare's counter resets per
 * calendar month, and a ledger summed over a rolling 30-day window would refuse uploads
 * Cloudflare would have accepted, every month, for the last few days of it.
 *
 * UTC, because a Worker has no local time zone and Venezuela's offset would put the
 * boundary four hours out in the direction that made us optimistic.
 */
export function transformationMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Which end of the animal's order a photo is being uploaded to.
 *
 * `primary` is the first photo in the session, and the only one that gets a digest
 * thumbnail and a social preview — the two derivatives whose consumers only ever show one
 * image. The name is CONTEXT.md's; there is no term for the others, so they are
 * `additional`.
 */
export type PhotoRole = "primary" | "additional";

/**
 * The derivatives a photo in this role gets, read off {@link DERIVATIVES} rather than
 * listed again. Listing them twice is how the set and the rule drift apart.
 */
export function derivativesFor(role: PhotoRole): DerivativeName[] {
  return (Object.keys(DERIVATIVES) as DerivativeName[]).filter(
    (name) =>
      DERIVATIVES[name].appliesTo === "everyPhoto" || role === "primary",
  );
}

/**
 * What one photo costs against {@link MONTHLY_TRANSFORMATION_BUDGET}: four for the primary,
 * two for every other. ADR 0012's `2N + 2` per animal is this summed over N photos, and
 * `upload.test.ts` asserts the two agree rather than trusting them to.
 *
 * This is the *worst* case. The upload path spends less whenever a derivative key already
 * exists, because an identical photo has been uploaded before and content-addressed keys
 * make that free — but a budget check that assumed the discount would be a budget check
 * that sometimes let an upload through it could not pay for.
 */
export function transformationsFor(role: PhotoRole): number {
  return derivativesFor(role).length;
}

/** ADR 0012's `2N + 2`, for an animal of `photoCount` photos. */
export function transformationsForAnimal(photoCount: number): number {
  return (
    transformationsFor("primary") +
    transformationsFor("additional") * (photoCount - 1)
  );
}

/**
 * The R2 storage ladder of ADR 0012, driven by ADR 0016's measured bytes.
 *
 * - `normal` — nothing to do.
 * - `alarming` — past 6 GB. Everything still works; the admin is told.
 * - `degraded` — past 8 GB, **or the measurement is missing or stale**. One photo per
 *   animal instead of six, which roughly quadruples the remaining headroom, "and a
 *   one-photo listing still finds a home where a rejected upload loses a shelter
 *   permanently."
 * - `refusing` — past ~9.5 GB. The last stop before R2 starts billing.
 */
export type StorageMode = "normal" | "alarming" | "degraded" | "refusing";

/** Decimal GB, which is the unit Cloudflare states the 10 GB allowance in. */
const GB = 1_000_000_000;

export const STORAGE_ALARM_BYTES = 6 * GB;
export const STORAGE_DEGRADE_BYTES = 8 * GB;
export const STORAGE_REFUSE_BYTES = 9.5 * GB;

/**
 * How old a measurement may be before the upload path stops believing it.
 *
 * ADR 0016: "if the sweep stops running the row stops moving, so the upload path treats a
 * measurement older than 3 days as a reason to degrade... rather than as licence to keep
 * trusting the last value." The row is expected to be up to 24 hours stale by design, so
 * three days is a missed run plus slack, not a tight bound.
 */
export const STORAGE_MEASUREMENT_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/**
 * The one row ADR 0016's nightly pass writes and this path reads. Written by issue #66;
 * `null` here until it has ever run, which is exactly the missing-measurement case below.
 */
export interface StorageMeasurement {
  readonly totalBytes: number;
  readonly measuredAt: Date;
}

/**
 * The mode in force, derived rather than read.
 *
 * The sweep records the mode it concluded, and this deliberately does not trust that
 * column: deriving it from the bytes in the same row means the number and the mode cannot
 * disagree, on the same reasoning that derives age bands and staleness instead of storing
 * them. The stored mode is for the admin mail and the run summary.
 *
 * A missing or stale measurement degrades. That is the *cautious* direction and it is
 * chosen on asymmetry: degrading costs a shelter five photos it can add later, and
 * trusting a dead sweep costs the platform a bill it cannot pay.
 */
export function deriveStorageMode(
  measurement: StorageMeasurement | null,
  now: Date,
): StorageMode {
  if (measurement === null) return "degraded";
  if (
    now.getTime() - measurement.measuredAt.getTime() >
    STORAGE_MEASUREMENT_MAX_AGE_MS
  ) {
    return "degraded";
  }
  if (measurement.totalBytes >= STORAGE_REFUSE_BYTES) return "refusing";
  if (measurement.totalBytes >= STORAGE_DEGRADE_BYTES) return "degraded";
  if (measurement.totalBytes >= STORAGE_ALARM_BYTES) return "alarming";
  return "normal";
}

/** How many photos an animal may carry under this mode. */
export function photoLimitFor(mode: StorageMode): number {
  if (mode === "refusing") return 0;
  if (mode === "degraded") return MIN_PHOTOS_PER_ANIMAL;
  return MAX_PHOTOS_PER_ANIMAL;
}

/**
 * Why an upload cannot be accepted.
 *
 * Every one of these is decided before a byte is stored, and every one of them is a
 * sentence a shelter can act on — which is why `file-too-large` and `image-too-large` are
 * separate reasons even though both mean "pick a different photo": one is fixed by sending
 * a smaller file and the other by not sending a 200-megapixel scan.
 */
export type UploadRefusalReason =
  /** The 24 hours ran out. The shelter starts again; nothing it uploaded is lost to it. */
  | "session-expired"
  /** Six already, or one already under a degraded storage mode. */
  | "photo-limit-reached"
  /**
   * This exact photograph is already in this session.
   *
   * Not a storage concern — the content-addressed keys already make a second copy free — but
   * a product one: six near-identical gallery slots is a shelter that meant to add a
   * different photo and does not know it did not. It is the one refusal that cannot be
   * decided before the bytes are read, since "the same bytes" is a fact about their digest.
   */
  | "duplicate-photo"
  | "unsupported-type"
  | "file-too-large"
  /** Beyond {@link MAX_ORIGINAL_DIMENSION} on a side or {@link MAX_ORIGINAL_PIXELS} of area. */
  | "image-too-large"
  /** R2 is full enough that the platform will not accept anything at all. */
  | "storage-exhausted"
  /** This calendar month's transformations are spent. Not the shelter's fault, and it must be told so. */
  | "transformation-budget-exhausted";

export interface UploadRefusal {
  readonly reason: UploadRefusalReason;
  /** The number the upload was judged against, where there is one, for the message. */
  readonly limit?: number;
  /** What the upload actually was, where it is known. */
  readonly actual?: number;
}

/**
 * Everything known about an upload before its bytes are read.
 *
 * `declaredBytes` is the `Content-Length` the browser sent, which is a claim rather than a
 * fact — `web/src/lib/photos/pipeline.ts` holds the body to that claim while it streams, so
 * a request that sends more than it promised fails the write. It is judged here because it
 * is the only size available before the body is touched, and refusing a 40 MB upload
 * without reading 40 MB is the entire point.
 *
 * `null` is a body that declared no length at all. It is not a *size* refusal — there is no
 * size to judge — and the route refuses it for a different reason, with a 411: R2 will not
 * accept a stream whose length is unknown, so such a body could not be streamed at all.
 */
export interface UploadPreflight {
  readonly contentType: string;
  readonly declaredBytes: number | null;
  readonly sessionCreatedAt: Date;
  readonly photosInSession: number;
  readonly transformationsUsedThisMonth: number;
  readonly storage: StorageMeasurement | null;
}

/**
 * Why this upload cannot be accepted, or `null`.
 *
 * The order of the checks is part of the answer, not an implementation detail. The
 * shelter-fixable reasons come first, so a shelter sending a 40 MB photo is told about its
 * photo rather than about the platform's storage — and the platform-wide refusals come
 * last, where they read as what they are: not your fault, try later.
 *
 * `photo-limit-reached` is deliberately reported before the file is judged. A seventh
 * photo is refused whatever its size, and telling a shelter its file was too big when a
 * one-byte file would also have been refused sends it off to re-export a photo for nothing.
 */
export function refuseUpload(
  preflight: UploadPreflight,
  now: Date,
): UploadRefusal | null {
  if (
    now.getTime() - preflight.sessionCreatedAt.getTime() >=
    UPLOAD_SESSION_TTL_MS
  ) {
    return { reason: "session-expired", limit: UPLOAD_SESSION_TTL_MS };
  }

  const mode = deriveStorageMode(preflight.storage, now);

  if (mode === "refusing") {
    return { reason: "storage-exhausted", limit: STORAGE_REFUSE_BYTES };
  }

  const photoLimit = photoLimitFor(mode);
  if (preflight.photosInSession >= photoLimit) {
    return {
      reason: "photo-limit-reached",
      limit: photoLimit,
      actual: preflight.photosInSession,
    };
  }

  if (!ACCEPTED_ORIGINAL_TYPES.includes(preflight.contentType)) {
    return { reason: "unsupported-type" };
  }

  if (
    preflight.declaredBytes !== null &&
    preflight.declaredBytes > MAX_ORIGINAL_BYTES
  ) {
    return {
      reason: "file-too-large",
      limit: MAX_ORIGINAL_BYTES,
      actual: preflight.declaredBytes,
    };
  }

  // The role the photo is *about to* take, which is what it will cost. A session with no
  // photos in it yet is uploading its primary.
  const role: PhotoRole =
    preflight.photosInSession === 0 ? "primary" : "additional";
  const cost = transformationsFor(role);
  const remaining =
    MONTHLY_TRANSFORMATION_BUDGET - preflight.transformationsUsedThisMonth;
  if (cost > remaining) {
    return {
      reason: "transformation-budget-exhausted",
      limit: MONTHLY_TRANSFORMATION_BUDGET,
      actual: preflight.transformationsUsedThisMonth,
    };
  }

  return null;
}

/**
 * The dimension check, split out because it is the one refusal that needs bytes.
 *
 * `web/src/lib/photos/dimensions.ts` reads the width and height out of the file's *header*
 * — a few hundred bytes, no decode — and this judges them, so the refusal still lands
 * before anything reaches R2. Splitting the decision from the parse is what lets the
 * thresholds be tested with two integers.
 *
 * It judges dimensions and deliberately not bytes. The byte cap belongs to
 * {@link refuseUpload}, which decides it before the body is touched at all, and the stream
 * then holds the body to the length it declared — so a second byte check here would be a
 * second answer to a question that already has one.
 */
export function refuseImage(size: {
  readonly width: number;
  readonly height: number;
}): UploadRefusal | null {
  const longestSide = Math.max(size.width, size.height);
  if (longestSide > MAX_ORIGINAL_DIMENSION) {
    return {
      reason: "image-too-large",
      limit: MAX_ORIGINAL_DIMENSION,
      actual: longestSide,
    };
  }
  const pixels = size.width * size.height;
  if (pixels > MAX_ORIGINAL_PIXELS) {
    return { reason: "image-too-large", limit: MAX_ORIGINAL_PIXELS, actual: pixels };
  }
  return null;
}

/**
 * An upload session as anything outside `web/` needs to see it.
 *
 * **There is no status here, and that is the design.** ADR 0016: "an upload session gains
 * no `Abandoned` state and no writer to set one". The two facts below are all abandonment
 * ever needed, and both are already stored for other reasons.
 */
export interface UploadSessionFacts {
  readonly createdAt: Date;
  /**
   * Whether an animal was ever written from this session — which is what "committed"
   * means, and the only thing that saves a session from being collected. Issue #55 writes
   * the reference; until it exists this is `false` for every session, which is correct
   * rather than provisional: a platform with no animals has no committed sessions.
   */
  readonly hasCommittedAnimal: boolean;
}

/**
 * Whether a shelter may still add to this session.
 *
 * The mirror image of {@link isAbandoned}, and written as one expression rather than two
 * so the boundary cannot be off by one on one side and not the other.
 */
export function isResumable(
  session: UploadSessionFacts,
  now: Date,
): boolean {
  return now.getTime() - session.createdAt.getTime() < UPLOAD_SESSION_TTL_MS;
}

/**
 * Whether the sweep may treat this session's derivatives as unreferenced.
 *
 * Derived from elapsed time and the absence of an animal, never read from a column —
 * ADR 0016's decision, and the reason it holds is that "no code is running at the moment a
 * session dies", so any stored state would need a writer that does not exist.
 *
 * A committed session is never abandoned however old it gets: its photos belong to an
 * animal, and the animal is what references them from then on.
 */
export function isAbandoned(
  session: UploadSessionFacts,
  now: Date,
): boolean {
  if (session.hasCommittedAnimal) return false;
  return !isResumable(session, now);
}
