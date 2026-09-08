/**
 * A regeneration: read the listable set, write the whole index, swing the pointer, keep the
 * prefix.
 *
 * [ADR 0018](../../../../docs/adr/0018-the-filter-index-is-rewritten-whole-and-found-through-a-pointer.md)
 * decides every line of this. **A regeneration reads the listable set from D1 and writes the
 * whole index** — never a patch, never a delta, never derived from a previous index — and
 * **its unit is the act**: one publish, one departure, one verification, one nudge answered
 * for a shelterful, one regeneration each, after the transaction commits.
 *
 * A patch would be the more expensive way to be wrong. It derives the index from the previous
 * index, so a lost write is permanent: miss one delta and the animal is absent from every
 * index built afterwards, forever, and nothing ever notices. A rewrite derives the index from
 * D1, which is the truth, so it is self-correcting by construction — which is why there is no
 * repair queue and no `index_dirty` row anywhere in this folder. Index Drift is not repaired,
 * it is regenerated away.
 *
 * ## Nothing here is ever invalidated, because nothing is ever overwritten
 *
 * The index object's key is a hash of its bytes and it is served `immutable`, exactly as a
 * derivative is ([ADR 0012](../../../../docs/adr/0012-derivatives-are-generated-once-at-upload.md)).
 * A new index is a new key. The only thing that moves is the pointer, and it is a hundred
 * bytes marked `no-store`. So **no cache purge exists anywhere in the publish path** — a purge
 * would be Worker work and an API dependency, against ADR 0007's rule that the Worker runs as
 * rarely as possible.
 *
 * ## Why an unchanged catalogue costs nothing that accumulates
 *
 * Content-addressing is what makes issue #66's nightly backstop free: when nothing listed has
 * changed, the regeneration produces identical bytes, hence an identical key, hence a `put`
 * over the object that is already there and a pointer that goes on naming it. That property
 * belongs to the bytes, so the bytes have to be deterministic — which is what the `ORDER BY`
 * in `./store.ts` and the sort in `domain/`'s `serializeIndex` are both holding up, and what
 * makes {@link RegenerationResult}'s `changed` a true statement about drift rather than a
 * statement about whether anyone published today.
 */

import type { Database } from "@pawster/db";
import type { FilterIndex, IndexPointer, StoredIndexObject } from "@pawster/domain";
import {
  INDEX_CACHE_CONTROL,
  INDEX_CONTENT_ENCODING,
  INDEX_CONTENT_TYPE,
  INDEX_POINTER_KEY,
  INDEX_PREFIX,
  POINTER_CACHE_CONTROL,
  indexGeneratedAt,
  indexObjectKey,
  isSupersededIndexObject,
  serializeIndex,
} from "@pawster/domain";
import { sha256Hex } from "../photos/keys.ts";
import { readListableAnimals } from "./store.ts";

/**
 * What one regeneration did, for the caller that asked for it and for issue #66's run
 * summary.
 *
 * `changed` is ADR 0018's **drift signal, and the signal is the key rather than the
 * pointer**: the pointer's own bytes carry `generatedAt` and therefore change every run, so
 * the pointer changing means nothing, while a nightly run landing on a key the pointer did
 * not already name means a publish-path write had been lost. That comparison is why a
 * regeneration opens by reading the pointer, and it is costed in the ADR's table as the one
 * Class B operation.
 */
export interface RegenerationResult {
  readonly key: string;
  readonly animalCount: number;
  /** How many listed animals had no primary photograph — see `./store.ts`. */
  readonly withoutPhoto: number;
  /** Whether the pointer already named this key. `false` is the ADR's drift signal. */
  readonly changed: boolean;
  /** How many superseded index objects this run collected out of `i/`. */
  readonly collected: number;
}

export interface RegenerationEnv {
  readonly db: Database;
  readonly media: R2Bucket;
  readonly now: Date;
}

/**
 * The pointer as it stands, or `null` if there has never been one.
 *
 * A `null` is the platform's first regeneration and nothing else: the pointer is written by
 * this function alone, so its absence cannot mean anything a caller has to handle. Unparseable
 * bytes are treated the same way rather than thrown on — the pointer is about to be
 * overwritten with something correct, and refusing to publish an index because the *old*
 * pointer was damaged would be the one failure this design has no way to recover from.
 */
async function readPointer(media: R2Bucket): Promise<IndexPointer | null> {
  const object = await media.get(INDEX_POINTER_KEY);
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as IndexPointer;
  } catch {
    return null;
  }
}

/** Gzip, through the platform's own stream rather than a bundled compressor. */
async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(new TextEncoder().encode(text));
  void writer.close();
  return await new Response(stream.readable).arrayBuffer();
}

/**
 * `put` the index, retrying **once** inline before giving up.
 *
 * ADR 0018's first line of defence against Index Drift: "the failing act retries the `put`
 * once inline — it is I/O, so it is affordable — and if it still fails, tells the shelter the
 * truth: the animal is saved, the listing follows." One retry and not a loop, because the
 * second failure is not a blip and the act it belongs to is a shelter waiting on a form.
 *
 * The throw is what carries "the listing follows" to the caller. It is deliberately raised
 * *before* the pointer is swung, so a failure leaves the previous index standing rather than
 * publishing a pointer to bytes that are not there.
 */
async function putOnce(
  media: R2Bucket,
  key: string,
  body: ArrayBuffer,
  httpMetadata: R2PutOptions["httpMetadata"],
): Promise<void> {
  try {
    await media.put(key, body, { httpMetadata });
  } catch {
    await media.put(key, body, { httpMetadata });
  }
}

/**
 * Read the truth, write the whole index, then swing the pointer — in that order, and the
 * order is the safety property.
 *
 * The index object is written before the pointer that names it, so an adopter reading at any
 * moment gets a coherent index: either the previous one, or this one, never a pointer to
 * bytes that do not exist. That is the same ordering ADR 0012 gives the publish path, and it
 * is why derivative immutability means "an adopter reading mid-write provably gets a coherent
 * *old* index".
 *
 * **The pointer is last-write-wins, with no lock and no compare-and-swap.** Two acts
 * regenerating at once means the loser's index is orphaned and the pointer may name an index
 * built from a read of D1 taken before the other act committed — which is Index Drift, healed
 * by the next act of any kind and bounded by the nightly run. A Durable Object to serialize a
 * race that heals itself would be a new component for nothing.
 *
 * It is synchronous and in the request path, which keeps publish-to-visible at the "seconds,
 * not a rebuild" ADR 0007 promised and surfaces the failure to the actor who caused it. *If
 * ADR 0018's first measurement puts serialize-and-hash over the 10 ms CPU ceiling, this call
 * moves to a message on the queue `digest/` already consumes — a seam that exists rather than
 * a new component, and one this signature is already shaped for.*
 */
export async function regenerateIndex(
  env: RegenerationEnv,
): Promise<RegenerationResult> {
  const previous = await readPointer(env.media);

  /** Throws on an incomplete read, which is the one thing that aborts a regeneration. */
  const listable = await readListableAnimals(env.db);

  const index: FilterIndex = {
    generatedAt: indexGeneratedAt(env.now),
    animals: listable.animals,
  };
  const text = serializeIndex(index);

  /**
   * Hashed over the **serialized JSON bytes** and not over the gzipped ones, as ADR 0018
   * words it. The distinction is not cosmetic: a compressor's output may vary with its
   * implementation or its level, so hashing it would let two runs over identical data land on
   * two keys — which is exactly the idempotence the whole nightly no-op rests on. The JSON is
   * ours and is deterministic; the gzip of it need only be *some* valid encoding of it.
   */
  const key = indexObjectKey(await sha256Hex(text));

  await putOnce(env.media, key, await gzip(text), {
    contentType: INDEX_CONTENT_TYPE,
    /**
     * Stored gzipped with the encoding declared, so 33.4 KB is the wire cost whatever fronts
     * the bucket. **ADR 0018's third open measurement is whether R2 serves this back**, and
     * the failure is loud but expensive if it does not: an adopter downloads ~352 KB of
     * uncompressed JSON and blows ADR 0007's ~150 KB budget on the first load. The fallback —
     * compressing per response — is Worker work on the read path, which is the thing ADR 0007
     * exists to avoid, so it is worth verifying before the listing ships rather than after.
     */
    contentEncoding: INDEX_CONTENT_ENCODING,
    cacheControl: INDEX_CACHE_CONTROL,
  });

  const pointer: IndexPointer = { key, generatedAt: env.now.toISOString() };
  await env.media.put(INDEX_POINTER_KEY, JSON.stringify(pointer), {
    httpMetadata: {
      contentType: INDEX_CONTENT_TYPE,
      cacheControl: POINTER_CACHE_CONTROL,
    },
  });

  return {
    key,
    animalCount: listable.animals.length,
    withoutPhoto: listable.withoutPhoto,
    changed: previous?.key !== key,
    collected: await collectSuperseded(env.media, key, env.now),
  };
}

/**
 * A regeneration on behalf of one act, which reports failure as an answer rather than as a
 * throw.
 *
 * **This is the one place an exception from the index write is caught, and ADR 0018 is why.**
 * The act — a publish, an edit, a confirmation — has already committed its D1 transaction, and
 * that transaction is the truth. Letting the index's failure take the act's response with it
 * would tell a shelter its animal was not saved when it was, which is the worst available
 * answer: the shelter would publish it again.
 *
 * So the failure becomes a `null`, and the caller words it. What that costs is Index Drift in
 * the invisible direction — an animal that exists and no adopter can see — and ADR 0018 names
 * the three things that regenerate it away without anyone recording that it happened: the
 * inline retry that has just been spent, **the shelter's next act of any kind**, since every
 * act is a full rewrite from D1, and issue #66's unconditional nightly regeneration, which
 * bounds the drift at one run. That is the whole argument for having no repair queue and no
 * `index_dirty` row: a row like that needs a writer at the moment of failure, which is the
 * moment least likely to have one.
 *
 * The sentence the shelter reads is the ADR's: *the animal is saved, the listing follows.*
 */
export async function regenerateForAct(
  env: RegenerationEnv,
): Promise<RegenerationResult | null> {
  try {
    return await regenerateIndex(env);
  } catch {
    return null;
  }
}

/**
 * List `i/` and delete what is superseded — the regenerator keeping its own prefix.
 *
 * **This is reconciliation, not a path remembering to clean up after itself**, which is why
 * it does not contradict `CONTEXT.md`'s Reclamation. The distinguishing property is
 * ADR 0016's: this is a `list` compared against a live reference, not a tombstone written at
 * the moment of unreferencing. If a run dies before deleting, the next run lists `i/` again
 * and collects what was missed; nothing has to have been recorded.
 *
 * It lives with the regenerator rather than with the nightly sweep because `i/` has exactly
 * one reference — the pointer — and exactly one writer, which is holding that reference in its
 * hand at the moment it swings it. **ADR 0016's sweep still lists `d/` only**, and the index
 * is not opted into it.
 *
 * The three conditions are `domain/`'s `isSupersededIndexObject`, tested there without a
 * bucket in the way. One `delete` taking an array of keys, which is the batching ADR 0016's
 * sweep already relies on and what keeps a regeneration at six subrequests.
 */
async function collectSuperseded(
  media: R2Bucket,
  pointerKey: string,
  now: Date,
): Promise<number> {
  /**
   * One page, and a truncated one is not a bug here. `i/` holds the pointer, the live index
   * and an hour's worth of superseded ones, so a page is orders of magnitude more than it
   * takes; and if a pathological hour ever exceeded one, the remainder is collected by the
   * next run, which lists the prefix again from the start. That is the same self-healing
   * property that makes a lost delete cost nothing — the bound is an hour of acts rather
   * than all of history either way.
   */
  const listed = await media.list({ prefix: INDEX_PREFIX });

  const superseded = listed.objects
    .map(
      (object): StoredIndexObject => ({
        key: object.key,
        /** R2 returns `uploaded` on every listed object, so the age test needs no join. */
        uploaded: object.uploaded,
      }),
    )
    .filter((object) => isSupersededIndexObject(object, { pointerKey, now }))
    .map((object) => object.key);

  if (superseded.length > 0) await media.delete(superseded);
  return superseded.length;
}
