/**
 * Where a photo's bytes live: one key per derivative, hashed over the source, and one for
 * the original, which is not.
 *
 * The shaping is `domain/`'s — it is the half two Workers share, since the nightly
 * reclamation sweep has to compute exactly the keys the upload path wrote or it will delete
 * a live animal's objects. What is here is the half `domain/` cannot do, which is the hash
 * itself: `crypto.subtle` is a global that package deliberately does not reach for.
 */

import {
  type DerivativeName,
  derivativeKeyFor,
  derivativeKeyMaterial,
} from "@pawster/domain";

/** The prefix originals live under in `pawster-originals`, which the 7-day rule collects. */
export const ORIGINAL_PREFIX = "o/";

/** SHA-256 as lowercase hex, which is the form every digest in this path is written in. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** An `ArrayBuffer` of digest bytes as lowercase hex. */
export function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * The object key for one derivative of the photo whose bytes hash to `sourceDigest`.
 *
 * Content-addressed, so two shelters uploading the same photograph write one object and
 * the second upload costs no transformation at all — the pipeline finds the key already
 * there. That is also the property [ADR 0016](../../../../docs/adr/0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md)
 * is about: it makes "this key is dead" something that can only be established by looking
 * at every reference in the platform, never at the key.
 */
export async function derivativeKey(
  sourceDigest: string,
  name: DerivativeName,
): Promise<string> {
  return derivativeKeyFor(
    await sha256Hex(derivativeKeyMaterial(sourceDigest, name)),
    name,
  );
}

/**
 * Where the original is parked for the seven days the lifecycle rule gives it.
 *
 * **Not content-addressed, and it cannot be.** The bytes go straight to R2 as they arrive
 * (ADR 0012: "browser to Worker to R2, streamed"), so the key has to be chosen before a
 * single byte has been seen, and a digest by definition is not available until the last one
 * has. Keying it by the photo's own id costs two copies of a photograph uploaded twice —
 * for seven days, in a bucket nothing serves from — and saves holding 12 MB in the isolate
 * to find out they were the same.
 */
export function originalKey(photoId: string): string {
  return `${ORIGINAL_PREFIX}${photoId}`;
}
