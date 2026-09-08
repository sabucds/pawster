/**
 * One photo, from the browser's request body to four objects in R2 — the whole of
 * [ADR 0012](../../../../docs/adr/0012-derivatives-are-generated-once-at-upload.md)'s
 * upload path in one place.
 *
 * ## The order is the design
 *
 * 1. **Read the header only.** A few hundred kilobytes, enough to know what the file is and
 *    how big the image will be. Nothing is stored yet.
 * 2. **Refuse, if it must be refused.** Type and dimensions, judged by `domain/`. This is
 *    the last moment at which refusing is free, which is exactly why ADR 0012 puts the
 *    caps here: "reject any input over 12 MB or beyond a maximum dimension *before storing
 *    anything*".
 * 3. **Stream the bytes to the originals bucket**, hashing them on the way past. Browser to
 *    Worker to R2, one photo per request — "presigned S3 URLs, their CORS policy and their
 *    credentials in the Worker are all unnecessary complexity here".
 * 4. **Mint a capability over the stored original** and hand it to the image pipeline.
 * 5. **Transform only what is missing.** The derivative keys are the content, so an
 *    identical photograph anywhere on the platform has already produced them.
 * 6. **Write them under `d/`, immutable, forever.**
 *
 * The row in D1 is written by the caller, after all of this — so a failure at any step
 * leaves an orphaned original that the 7-day lifecycle rule collects, orphaned derivatives
 * that ADR 0016's nightly sweep collects, and **no photo**. Nothing partial ever becomes an
 * animal, and no cleanup code has to exist for either.
 *
 * ## Why the original is streamed and the derivatives are not
 *
 * The original may be 12 MB, so it goes through a `FixedLengthStream` and is never held
 * whole in the isolate. A derivative is a 144x144 JPEG or a 1280px WebP, and buffering one
 * is both cheap and necessary: `R2.put` needs a stream whose length is known in advance,
 * and the transform's response is the one thing here whose length nobody knows until it
 * arrives.
 *
 * That `FixedLengthStream` is also the second half of the size cap. The declared
 * `Content-Length` is checked against 12 MB before a byte is read, and the stream then holds
 * the body to that declaration — a request that sends more than it promised, or less, fails
 * the write instead of quietly storing something else.
 */

import {
  type DerivativeName,
  DERIVATIVE_CACHE_CONTROL,
  type PhotoRole,
  type UploadRefusal,
  derivativeContentType,
  derivativesFor,
  refuseImage,
} from "@pawster/domain";
import { HEADER_BYTES, readImageSize, sniffContentType } from "./dimensions.ts";
import { type MediaSecrets, mintOriginalToken } from "./capability.ts";
import { fetchDerivative } from "../images.ts";
import { derivativeKey, originalKey, toHex } from "./keys.ts";

export interface MediaBuckets {
  /** `pawster-originals`. Never public, because a retained original still carries EXIF. */
  readonly ORIGINALS: R2Bucket;
  /** `pawster-media`, where derivatives live under `d/`. */
  readonly MEDIA: R2Bucket;
}

export interface StorePhotoInput {
  readonly body: ReadableStream<Uint8Array>;
  /**
   * The `Content-Length`, already checked against 12 MB by the caller. Required rather than
   * optional: `R2.put` will not take a stream of unknown length, so a body with no declared
   * length cannot be streamed at all — the route answers 411 rather than buffering 12 MB to
   * find out how big it was.
   */
  readonly declaredBytes: number;
  /** The photo's id, which is also its original's key. */
  readonly photoId: string;
  readonly role: PhotoRole;
  /**
   * Where this Worker answers, as the image pipeline will reach it. Taken from the incoming
   * request rather than from a configured origin, so the pipeline is pointed at the
   * deployment that actually holds the original — which is what makes this work identically
   * on `workers.dev`, on a preview deployment and under a custom domain.
   */
  readonly origin: string;
  readonly now: Date;
}

export interface StoredPhoto {
  readonly sourceDigest: string;
  readonly originalKey: string;
  /** What the file actually is, from its magic bytes — never the label the browser sent. */
  readonly contentType: string;
  readonly byteSize: number;
  /** Display dimensions: after rotation, which is the only form that will exist. */
  readonly width: number;
  readonly height: number;
  readonly derivatives: Readonly<Partial<Record<DerivativeName, string>>>;
  /**
   * What this upload actually cost against the month's 5,000 — which is fewer than the
   * role's price whenever a derivative was already in the bucket, and zero for a photograph
   * the platform has seen before.
   */
  readonly transformationsSpent: number;
}

/** A refusal that could only be made once some bytes had been read. */
export interface PhotoRefused {
  readonly refusal: UploadRefusal;
}

export function isRefused(
  result: StoredPhoto | PhotoRefused,
): result is PhotoRefused {
  return "refusal" in result;
}

/**
 * Read up to {@link HEADER_BYTES} without consuming the rest of the body.
 *
 * The chunks are kept rather than concatenated-and-forgotten, because they still have to be
 * written to R2 afterwards: this is a peek at a stream that will be replayed, not a read of
 * one that will be re-requested.
 */
async function peekHeader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ header: Uint8Array; chunks: Uint8Array[]; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;

  while (total < HEADER_BYTES) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    total += next.value.length;
  }

  const header = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    header.set(chunk, offset);
    offset += chunk.length;
  }
  return { header, chunks, done };
}

/**
 * Store one photo and produce its derivatives, or refuse it having stored nothing.
 *
 * The refusals this can still make are the two that need bytes — a file that is not an image
 * of an accepted type, and one whose dimensions are beyond what the pipeline will transform.
 * Every other refusal is the caller's, made before this is called at all.
 */
export async function storePhoto(
  buckets: MediaBuckets,
  secrets: MediaSecrets,
  input: StorePhotoInput,
): Promise<StoredPhoto | PhotoRefused> {
  const reader = input.body.getReader();
  const { header, chunks, done } = await peekHeader(reader);

  // What the file *is*, not what it was labelled. A HEIC renamed `.jpg` is a real thing a
  // shelter sends, because the label comes from the operating system's guess at an
  // extension — and the derivative set is decided by the pipeline, not by the source, so the
  // only thing the label could change is whether we refuse a file we could have read.
  const contentType = sniffContentType(header);
  const size = contentType === null ? null : readImageSize(header);
  if (contentType === null || size === null) {
    await reader.cancel();
    return { refusal: { reason: "unsupported-type" } };
  }

  const tooBig = refuseImage(size);
  if (tooBig) {
    await reader.cancel();
    return { refusal: tooBig };
  }

  const key = originalKey(input.photoId);
  const stored = await streamOriginal(buckets.ORIGINALS, key, contentType, {
    reader,
    chunks,
    done,
    declaredBytes: input.declaredBytes,
  });

  const token = await mintOriginalToken(secrets, key, input.now);
  const originalUrl = `${input.origin}/api/originales/${key}?token=${encodeURIComponent(token)}`;

  const derivatives: Partial<Record<DerivativeName, string>> = {};
  let transformationsSpent = 0;

  for (const name of derivativesFor(input.role)) {
    const derivativeObjectKey = await derivativeKey(stored.digest, name);
    derivatives[name] = derivativeObjectKey;

    // The content-addressed key is what makes this check worth making: an object already
    // under this key holds bytes produced from these bytes by this exact spec, so there is
    // nothing a transform could add. ADR 0016's shared-key case, arriving as a saving.
    if (await buckets.MEDIA.head(derivativeObjectKey)) continue;

    const response = await fetchDerivative(originalUrl, name);
    if (!response.ok) {
      throw new Error(
        `The image pipeline refused the ${name} transform: ${response.status} ` +
          `${response.headers.get("cf-resized") ?? ""}`.trim(),
      );
    }

    // Buffered rather than streamed: `R2.put` needs a length, and a transform's response is
    // the one body here whose length is not known before it arrives. A 1280px WebP is a few
    // hundred kilobytes, so this costs nothing the 12 MB original did not already cost.
    await buckets.MEDIA.put(derivativeObjectKey, await response.arrayBuffer(), {
      httpMetadata: {
        contentType: derivativeContentType(name),
        // Set on the object rather than on a response, because the object is what `r2.dev`
        // serves and what any cache in front of it will read (ADR 0014). Safe to the point
        // of being uninteresting: the key is the content.
        cacheControl: DERIVATIVE_CACHE_CONTROL,
      },
    });
    transformationsSpent++;
  }

  return {
    sourceDigest: stored.digest,
    originalKey: key,
    contentType,
    byteSize: stored.byteSize,
    width: size.width,
    height: size.height,
    derivatives,
    transformationsSpent,
  };
}

/**
 * `crypto.DigestStream`, reached through a cast, and the cast is the interesting part.
 *
 * The class is **declared globally** by `@cloudflare/workers-types` and **bound at runtime
 * on `crypto`** — Cloudflare's own documentation writes `new crypto.DigestStream(...)`, and
 * the bare global is a `ReferenceError` in `workerd`. The types cannot express that, because
 * `astro/tsconfigs/strict` pulls in the DOM `lib` and so `crypto` types as the DOM's
 * `Crypto`, which knows nothing of the runtime's extension. Writing the global satisfies the
 * compiler and fails in production; writing `crypto.DigestStream` does the reverse.
 *
 * So: the runtime's binding, with the type declaration that describes it. Both halves are
 * real, and this is the seam between them rather than an assertion that one of them is
 * wrong. Measured the hard way — `docs/testing-seams.md` records it.
 */
function digestStreamConstructor(): typeof DigestStream {
  return (crypto as unknown as { DigestStream: typeof DigestStream }).DigestStream;
}

/**
 * Write the body to the originals bucket, hashing it as it goes.
 *
 * One pass over the bytes producing two results, which is the only arrangement that both
 * streams to R2 and content-addresses the derivatives: the digest cannot exist until the
 * last byte has been seen, and the bytes must not be held in the isolate until then.
 * `crypto.DigestStream` is what makes the two compatible.
 *
 * On any failure the partially-written object is deleted. That delete is a courtesy rather
 * than a correctness requirement — the 7-day lifecycle rule would collect it, and no photo
 * row was written to point at it — but leaving a failed upload's bytes in the bucket for a
 * week distorts the byte measurement ADR 0016's caps are driven by.
 */
async function streamOriginal(
  bucket: R2Bucket,
  key: string,
  contentType: string,
  source: {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    chunks: Uint8Array[];
    done: boolean;
    declaredBytes: number;
  },
): Promise<{ digest: string; byteSize: number }> {
  const body = new FixedLengthStream(source.declaredBytes);
  // Started before anything is written, and deliberately not awaited here: `put` consumes
  // the readable half while the loop below fills the writable one, so awaiting it first
  // would deadlock on a body larger than the stream's internal queue.
  const put = bucket.put(key, body.readable, {
    httpMetadata: { contentType },
  });

  const DigestStreamClass = digestStreamConstructor();
  const digestStream = new DigestStreamClass("SHA-256");
  const digestWriter = digestStream.getWriter();
  const writer = body.writable.getWriter();
  let byteSize = 0;

  try {
    for (const chunk of source.chunks) {
      byteSize += chunk.length;
      await writer.write(chunk);
      await digestWriter.write(chunk);
    }
    if (!source.done) {
      while (true) {
        const next = await source.reader.read();
        if (next.done) break;
        byteSize += next.value.length;
        await writer.write(next.value);
        await digestWriter.write(next.value);
      }
    }
    await writer.close();
    await digestWriter.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await digestWriter.abort(error).catch(() => {});
    await put.catch(() => {});
    await bucket.delete(key).catch(() => {});
    throw error;
  }

  try {
    await put;
  } catch (error) {
    await bucket.delete(key).catch(() => {});
    throw error;
  }

  return { digest: toHex(await digestStream.digest), byteSize };
}
