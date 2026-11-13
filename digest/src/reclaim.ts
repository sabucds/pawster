/**
 * ADR 0016's nightly Reclamation, and the storage measurement that falls out of it.
 *
 * A derivative under `d/` is deleted only when no animal references it, no upload session
 * younger than 24 hours holds it, and the object itself is older than 24 hours. "This key is
 * dead" is never a fact about a key: keys are content-addressed, so two animals can share
 * one, and the only way to know nobody holds it is to compute every key that is held.
 *
 * Reclamation refuses rather than deletes when anything looks wrong. A failed reference read
 * throws before any listing starts, and a delete set larger than `max(200, 10%)` of what
 * `d/` holds deletes nothing. A skipped Reclamation costs about a megabyte; a wrong one is
 * permanent, because originals are gone after seven days and derivatives are cached
 * `immutable`.
 */

import {
  type Database,
  animals,
  storageMeasurements,
  uploadSessionPhotos,
  uploadSessions,
} from "@pawster/db";
import {
  DERIVATIVE_PREFIX,
  type StorageMode,
  derivativeKeyFor,
  derivativeKeyMaterial,
  derivativesFor,
  deriveStorageMode,
} from "@pawster/domain";
import { eq, gte, inArray, or } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60_000;
const REFUSE_FLOOR = 200;
const REFUSE_SHARE = 0.1;
/** R2's `delete` takes up to 1,000 keys per call. */
const DELETE_BATCH = 1000;

export interface ReclamationOutcome {
  readonly reclamation: "reclaimed" | "refused";
  /** How many objects `d/` held when listed, and how many Reclamation found unreferenced. */
  readonly listed: number;
  readonly unreferenced: number;
  readonly reclaimedObjects: number;
  readonly reclaimedBytes: number;
  readonly storedBytes: number;
  readonly mode: StorageMode;
}

/**
 * Run Reclamation and record the measurement. Throws, having deleted nothing, if the reference
 * read or any listing fails; the caller records that as an aborted Reclamation.
 */
export async function reclaimAndMeasure(
  buckets: { readonly MEDIA: R2Bucket; readonly ORIGINALS: R2Bucket },
  db: Database,
  now: Date,
): Promise<ReclamationOutcome> {
  const held = await heldDerivativeKeys(db, now);

  const derivatives = await listAll(buckets.MEDIA, DERIVATIVE_PREFIX);
  const oldEnough = now.getTime() - DAY_MS;
  const doomed = derivatives.filter(
    (object) => !held.has(object.key) && object.uploaded.getTime() < oldEnough,
  );

  const refused =
    doomed.length > Math.max(REFUSE_FLOOR, REFUSE_SHARE * derivatives.length);
  let reclaimedBytes = 0;
  if (!refused) {
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      await buckets.MEDIA.delete(doomed.slice(i, i + DELETE_BATCH).map((object) => object.key));
    }
    reclaimedBytes = doomed.reduce((sum, object) => sum + object.size, 0);
  }

  // The whole of both buckets, root included: R2's 10 GB is per account.
  const [media, originals] = await Promise.all([
    listAll(buckets.MEDIA),
    listAll(buckets.ORIGINALS),
  ]);
  const storedBytes = [...media, ...originals].reduce((sum, object) => sum + object.size, 0);
  const mode = deriveStorageMode({ totalBytes: storedBytes, measuredAt: now }, now);
  await db.insert(storageMeasurements).values({
    id: crypto.randomUUID(),
    totalBytes: storedBytes,
    mode,
    measuredAt: now,
  });

  return {
    reclamation: refused ? "refused" : "reclaimed",
    listed: derivatives.length,
    unreferenced: doomed.length,
    reclaimedObjects: refused ? 0 : doomed.length,
    reclaimedBytes,
    storedBytes,
    mode,
  };
}

/**
 * Every derivative key an animal or a live upload session holds. A photo at position 0 holds
 * all four derivatives and any other photo holds the two every photo gets, so a demoted
 * primary's digest thumbnail and social preview are released.
 *
 * Abandonment is derived here, never stored (ADR 0016): a session older than 24 hours that
 * no animal names holds nothing.
 */
async function heldDerivativeKeys(db: Database, now: Date): Promise<Set<string>> {
  const photos = await db
    .select({
      position: uploadSessionPhotos.position,
      sourceDigest: uploadSessionPhotos.sourceDigest,
    })
    .from(uploadSessionPhotos)
    .innerJoin(uploadSessions, eq(uploadSessions.id, uploadSessionPhotos.sessionId))
    .where(
      or(
        gte(uploadSessions.createdAt, new Date(now.getTime() - DAY_MS)),
        inArray(
          uploadSessions.id,
          db.select({ id: animals.uploadSessionId }).from(animals),
        ),
      ),
    );
  const keys = await Promise.all(
    photos.flatMap((photo) =>
      derivativesFor(photo.position === 0 ? "primary" : "additional").map(async (name) =>
        derivativeKeyFor(await sha256Hex(derivativeKeyMaterial(photo.sourceDigest, name)), name),
      ),
    ),
  );
  return new Set(keys);
}

/**
 * The same hash `web/src/lib/photos/keys.ts` writes keys with. `domain/` holds no
 * `crypto.subtle`, so each Worker hashes for itself; Reclamation's tests place objects with
 * `web/`'s function, so the two cannot drift apart unnoticed.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function listAll(bucket: R2Bucket, prefix?: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

/**
 * What the admin needs to hear about this Reclamation, or `null` when it went quietly: one that
 * aborted or refused, and any storage mode past normal.
 */
export function reclamationAlert(outcome: ReclamationOutcome | null): string | null {
  if (outcome === null) {
    return "Reclamation aborted: the reference read or a bucket listing failed, so nothing was deleted or measured. It runs again tomorrow.";
  }
  const lines: string[] = [];
  if (outcome.reclamation === "refused") {
    lines.push(
      `Reclamation refused: ${outcome.unreferenced} of ${outcome.listed} derivatives under d/ looked unreferenced, more than max(${REFUSE_FLOOR}, ${REFUSE_SHARE * 100}%). Nothing was deleted.`,
    );
  }
  if (outcome.mode !== "normal") {
    lines.push(`Storage is ${outcome.storedBytes} bytes across both buckets, which puts uploads in "${outcome.mode}" mode.`);
  }
  return lines.length === 0 ? null : lines.join("\n\n");
}

export async function mailAdmin(
  env: { RESEND_API_KEY: string; DIGEST_FROM_ADDRESS: string; ADMIN_EMAIL: string },
  text: string,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM_ADDRESS,
      to: [env.ADMIN_EMAIL],
      subject: "Pawster: reclamation needs a look",
      text,
    }),
  });
  if (!response.ok) throw new Error(`Resend rejected the admin mail: ${response.status}`);
}
