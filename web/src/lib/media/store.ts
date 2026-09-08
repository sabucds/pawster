/**
 * Every query the photo pipeline makes, and nothing else.
 *
 * Same posture as `auth/store.ts`: the queries live apart from the endpoints so that the
 * refusals stay pure functions in `domain/` with table tests, and so that no endpoint
 * assembles its own `SUM` and puts a limit back at the call site. No Drizzle client is built
 * here — every function takes one, because `db/src/index.ts` requires the client to be
 * constructed inside the request handler and `scripts/check-source-rules.mjs` fails the
 * build over a module that does otherwise.
 */

import type { Database } from "@pawster/db";
import {
  storageMeasurements,
  transformationSpends,
  uploadSessionPhotos,
  uploadSessions,
} from "@pawster/db";
import type { StorageMeasurement } from "@pawster/domain";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export interface UploadSessionRow {
  readonly id: string;
  readonly shelterId: string;
  readonly createdAt: Date;
}

export interface SessionPhotoRow {
  readonly id: string;
  readonly position: number;
  readonly sourceDigest: string;
  readonly originalKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly createdAt: Date;
}

export async function createUploadSession(
  db: Database,
  session: UploadSessionRow,
): Promise<void> {
  await db.insert(uploadSessions).values({
    id: session.id,
    shelterId: session.shelterId,
    createdAt: session.createdAt,
  });
}

/**
 * The session, or `null` if there is no such row.
 *
 * Deliberately **not** scoped to a shelter here. Whether the session belongs to the caller
 * is an authorisation question and it is answered at the endpoint, where the answer can be
 * a 404 rather than an empty result the caller has to interpret — and where it is visible
 * next to the `authenticate()` call it depends on.
 */
export async function findUploadSession(
  db: Database,
  id: string,
): Promise<UploadSessionRow | null> {
  const [row] = await db
    .select({
      id: uploadSessions.id,
      shelterId: uploadSessions.shelterId,
      createdAt: uploadSessions.createdAt,
    })
    .from(uploadSessions)
    .where(eq(uploadSessions.id, id))
    .limit(1);
  return row ?? null;
}

/** A session's photos in the shelter's own order, position 0 first and so primary. */
export async function listSessionPhotos(
  db: Database,
  sessionId: string,
): Promise<SessionPhotoRow[]> {
  return db
    .select({
      id: uploadSessionPhotos.id,
      position: uploadSessionPhotos.position,
      sourceDigest: uploadSessionPhotos.sourceDigest,
      originalKey: uploadSessionPhotos.originalKey,
      contentType: uploadSessionPhotos.contentType,
      byteSize: uploadSessionPhotos.byteSize,
      width: uploadSessionPhotos.width,
      height: uploadSessionPhotos.height,
      createdAt: uploadSessionPhotos.createdAt,
    })
    .from(uploadSessionPhotos)
    .where(eq(uploadSessionPhotos.sessionId, sessionId))
    .orderBy(uploadSessionPhotos.position);
}

/**
 * Record a stored photo and what its derivatives cost, in one batch.
 *
 * `db.batch` because the two rows are one fact. A photo recorded without its spend would
 * make the month's budget under-count and eventually let an upload through that Cloudflare
 * then refuses mid-transform — the failure the budget check exists to prevent — and a spend
 * recorded without its photo would spend budget on nothing.
 *
 * D1's batch is a single transaction, so there is no window in which one exists and not the
 * other.
 */
export async function recordSessionPhoto(
  db: Database,
  photo: Omit<SessionPhotoRow, "position"> & { readonly sessionId: string },
  spend: { readonly id: string; readonly transformations: number },
): Promise<number> {
  /**
   * The position is computed **inside the insert**, not read and then written.
   *
   * A shelter's form may well upload several photos at once, and two requests that each
   * read the highest position and then wrote it back would both write the same number —
   * where the unique index on `(session_id, position)` turns a race into a 500 for one of
   * them. A single `INSERT` is atomic, so the read and the write cannot be separated by
   * another writer.
   *
   * `max(position) + 1` rather than `count(*)`, because the two are only the same number
   * while nothing has ever been removed from a session, and issue #58's photo mutation will
   * make that false. A count would then hand out a position that is already taken.
   */
  const insertPhoto = db
    .insert(uploadSessionPhotos)
    .values({
      id: photo.id,
      sessionId: photo.sessionId,
      position: sql<number>`(select coalesce(max(${uploadSessionPhotos.position}) + 1, 0) from ${uploadSessionPhotos} where ${uploadSessionPhotos.sessionId} = ${photo.sessionId})`,
      sourceDigest: photo.sourceDigest,
      originalKey: photo.originalKey,
      contentType: photo.contentType,
      byteSize: photo.byteSize,
      width: photo.width,
      height: photo.height,
      createdAt: photo.createdAt,
    })
    .returning({ position: uploadSessionPhotos.position });

  // A photo that spent nothing — every derivative already existed — writes no ledger row.
  // A zero row would be a record of an event that did not happen.
  if (spend.transformations === 0) {
    const [row] = await insertPhoto;
    return row!.position;
  }

  const [inserted] = await db.batch([
    insertPhoto,
    db.insert(transformationSpends).values({
      id: spend.id,
      transformations: spend.transformations,
      spentAt: photo.createdAt,
    }),
  ]);
  return inserted[0]!.position;
}

/**
 * The first instant of the calendar month `now` falls in, UTC.
 *
 * Cloudflare's transformation counter resets per calendar month, and the platform's own
 * ledger has to reset on the same boundary or the two drift apart — a ledger on a rolling
 * 30-day window would refuse uploads Cloudflare would have accepted, every month, for the
 * last few days of it.
 *
 * UTC, because a Worker has no local time zone and Venezuela's offset would put the
 * boundary in the wrong place by four hours in a direction that made us optimistic.
 */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * How many transformations this calendar month has spent.
 *
 * A `SUM` over the ledger rather than a stored counter, for the reason `signInRequests` is a
 * ledger: a denormalised total is a second answer that can disagree with the history it
 * summarises, and at a few hundred rows a month there is nothing to optimise.
 */
export async function transformationsUsedThisMonth(
  db: Database,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${transformationSpends.transformations}), 0)`,
    })
    .from(transformationSpends)
    .where(gte(transformationSpends.spentAt, monthStart(now)));
  return Number(row?.total ?? 0);
}

/**
 * The most recent measurement the nightly sweep wrote, or `null` if it has never run.
 *
 * `null` is not "the platform is empty" — `domain/`'s `deriveStorageMode` degrades on it,
 * the same as it degrades on a stale one. The `mode` column is deliberately not read: the
 * mode is derived from the bytes in this same row, so the two cannot disagree.
 */
export async function latestStorageMeasurement(
  db: Database,
): Promise<StorageMeasurement | null> {
  const [row] = await db
    .select({
      totalBytes: storageMeasurements.totalBytes,
      measuredAt: storageMeasurements.measuredAt,
    })
    .from(storageMeasurements)
    .orderBy(desc(storageMeasurements.measuredAt))
    .limit(1);
  return row ?? null;
}

/**
 * Whether this session already holds a photo with these exact bytes.
 *
 * Not a deduplication of storage — the content-addressed keys already do that, and better,
 * across every session on the platform. This answers a different question: the same
 * photograph twice in one animal is six near-identical gallery slots and a shelter that
 * meant to add a different photo. It is a refusal, not an optimisation.
 */
export async function sessionHoldsDigest(
  db: Database,
  sessionId: string,
  sourceDigest: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: uploadSessionPhotos.id })
    .from(uploadSessionPhotos)
    .where(
      and(
        eq(uploadSessionPhotos.sessionId, sessionId),
        eq(uploadSessionPhotos.sourceDigest, sourceDigest),
      ),
    )
    .limit(1);
  return row !== undefined;
}
