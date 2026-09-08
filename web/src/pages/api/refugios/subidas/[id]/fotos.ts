/**
 * One photo, one request.
 *
 * ADR 0012 settles the shape and the arithmetic behind it. The Free plan's request-body
 * limit is 100 MB, HTTP duration is documented as unlimited and streaming to `R2.put()` is
 * I/O rather than CPU — so "presigned S3 URLs, their CORS policy and their credentials in
 * the Worker are all unnecessary complexity here". One photo per request is also what keeps
 * the subrequest count near 5 of the Free plan's 50: an Images call spends exactly one
 * subrequest (measured, issue #34), and doing a six-photo animal in a single invocation
 * would spend 34–40.
 *
 * ## The body is the photo
 *
 * Raw bytes with a `Content-Type`, not `multipart/form-data`. A multipart body has exactly
 * one part here, and parsing it would mean either a parser of our own or
 * `request.formData()`, which buffers the whole 12 MB in the isolate — undoing the streaming
 * this endpoint is built around for no gain.
 *
 * ## What is checked, in what order, and why it is checked twice
 *
 * The session, then the caps, then the bytes. Everything that can be refused without
 * reading the body is refused first, and the pre-flight on `POST /api/refugios/subidas`
 * has already told the form most of it — but it is all re-checked here, because between the
 * two requests another shelter may have spent the last of the month's transformations. The
 * pre-flight is advice; this is the decision.
 */

import { createDb } from "@pawster/db";
import {
  UPLOAD_SESSION_TTL_MS,
  isResumable,
  refuseUpload,
} from "@pawster/domain";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { authenticate } from "../../../../../lib/auth/guard.ts";
import { isRefused, storePhoto } from "../../../../../lib/media/pipeline.ts";
import {
  refusalResponse,
  withRefreshedCookie,
} from "../../../../../lib/media/responses.ts";
import {
  findUploadSession,
  latestStorageMeasurement,
  listSessionPhotos,
  recordSessionPhoto,
  sessionHoldsDigest,
  transformationsUsedThisMonth,
} from "../../../../../lib/media/store.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const db = createDb(env.DB);
  const now = new Date();

  const shelter = await authenticate(request, db, env, now);
  if (!shelter) return new Response(null, { status: 401 });

  const sessionId = params.id;
  if (!sessionId) return new Response(null, { status: 404 });

  const session = await findUploadSession(db, sessionId);
  /**
   * A session belonging to another shelter answers **404 and not 403**. There is nothing to
   * tell the caller apart from a session that never existed, and a 403 would confirm that
   * this id is somebody's — the same reasoning that makes `guard.ts` collapse every session
   * failure onto one answer.
   */
  if (!session || session.shelterId !== shelter.shelterId) {
    return new Response(null, { status: 404 });
  }

  if (!request.body) return new Response(null, { status: 400 });

  /**
   * A body with no declared length cannot be streamed to R2 at all — `R2.put` requires a
   * stream whose length is known in advance — and buffering 12 MB to discover the length is
   * the thing this endpoint exists not to do. `411 Length Required` is the status for
   * exactly this, and a browser `fetch` with a `File` or `Blob` body always sets the header.
   */
  const declared = request.headers.get("content-length");
  if (declared === null) {
    // Cancelled rather than left hanging: this handler is finished with the body, and a
    // stream nobody reads and nobody closes is what makes the runtime log a disconnect.
    await request.body.cancel().catch(() => {});
    return new Response(null, { status: 411 });
  }
  const declaredBytes = Number(declared);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
    await request.body.cancel().catch(() => {});
    return new Response(null, { status: 400 });
  }

  const [storage, used, photos] = await Promise.all([
    latestStorageMeasurement(db),
    transformationsUsedThisMonth(db, now),
    listSessionPhotos(db, sessionId),
  ]);

  const refusal = refuseUpload(
    {
      // The label the browser sent, judged against the accepted list here, and then
      // ignored: the pipeline sniffs the magic bytes and refuses on what the file *is*.
      // Both, because the label is the only type available before the body is read and it
      // is not the truth about the body.
      contentType: (request.headers.get("content-type") ?? "").split(";")[0]!.trim(),
      declaredBytes,
      sessionCreatedAt: session.createdAt,
      photosInSession: photos.length,
      transformationsUsedThisMonth: used,
      storage,
    },
    now,
  );
  if (refusal) return refusalResponse(refusal, shelter.refreshedCookie);

  const url = new URL(request.url);
  const stored = await storePhoto(env, env, {
    body: request.body,
    declaredBytes,
    photoId: crypto.randomUUID(),
    /**
     * Position 0 is the primary, so the first photo into a session is the one that gets a
     * digest thumbnail and a social preview.
     *
     * The role is decided from the session as it stands *now*, while the position is
     * assigned atomically by the insert below — so two photos uploaded at once could both
     * be minted as primary. That costs two transformations and leaves two objects the
     * nightly sweep collects; what it cannot do is leave the actual primary short of a
     * derivative, because whichever photo lands at position 0 was minted believing it was
     * the primary. Erring toward the extra derivative is the only direction that is safe.
     */
    role: photos.length === 0 ? "primary" : "additional",
    origin: url.origin,
    now,
  });

  if (isRefused(stored)) {
    return refusalResponse(stored.refusal, shelter.refreshedCookie);
  }

  /**
   * The same photograph twice in one session is refused *after* it has been stored, and
   * that ordering is forced rather than chosen: "the same bytes" is a fact about the digest,
   * and the digest does not exist until the bytes have gone past. Nothing is wasted by
   * finding out late — the content-addressed keys mean the second upload produced no new
   * objects and spent no transformations, and the duplicate original expires in seven days.
   */
  if (await sessionHoldsDigest(db, sessionId, stored.sourceDigest)) {
    await env.ORIGINALS.delete(stored.originalKey).catch(() => {});
    return refusalResponse(
      { reason: "duplicate-photo" },
      shelter.refreshedCookie,
    );
  }

  const photoId = stored.originalKey.slice("o/".length);
  const position = await recordSessionPhoto(
    db,
    {
      id: photoId,
      sessionId,
      sourceDigest: stored.sourceDigest,
      originalKey: stored.originalKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      width: stored.width,
      height: stored.height,
      createdAt: now,
    },
    { id: crypto.randomUUID(), transformations: stored.transformationsSpent },
  );

  return withRefreshedCookie(
    Response.json(
      {
        id: photoId,
        position,
        width: stored.width,
        height: stored.height,
        byteSize: stored.byteSize,
        contentType: stored.contentType,
        /**
         * The keys, so the form can show what it just uploaded without a second request.
         * Opaque by construction — they are hashes — which is the cost ADR 0012 named for
         * having no cache purge anywhere in the publish path.
         */
        derivatives: stored.derivatives,
        transformationsSpent: stored.transformationsSpent,
      },
      { status: 201 },
    ),
    shelter.refreshedCookie,
  );
};

/**
 * What is in this session — which is the whole of "resumable for 24 hours".
 *
 * Resuming needs no mechanism beyond this. The session's photos are rows and its
 * derivatives are objects; both survive a dropped connection, a closed tab and a different
 * device, because neither was ever held in the browser. What a shelter gets back is what the
 * platform already had.
 */
export const GET: APIRoute = async ({ request, params }) => {
  const db = createDb(env.DB);
  const now = new Date();

  const shelter = await authenticate(request, db, env, now);
  if (!shelter) return new Response(null, { status: 401 });

  const sessionId = params.id;
  if (!sessionId) return new Response(null, { status: 404 });

  const session = await findUploadSession(db, sessionId);
  if (!session || session.shelterId !== shelter.shelterId) {
    return new Response(null, { status: 404 });
  }

  const photos = await listSessionPhotos(db, sessionId);

  return withRefreshedCookie(
    Response.json(
      {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        /**
         * Whether the session is still open, derived from its age here exactly as
         * abandonment is derived from it in the sweep. An expired session still answers
         * with its photos rather than a 410: a shelter that comes back to find the window
         * gone is better served by seeing what it had than by an empty page, and the
         * upload endpoint refuses the next photo either way.
         */
        expiresAt: new Date(
          session.createdAt.getTime() + UPLOAD_SESSION_TTL_MS,
        ).toISOString(),
        resumable: isResumable(
          { createdAt: session.createdAt, hasCommittedAnimal: false },
          now,
        ),
        photos: photos.map((photo) => ({
          id: photo.id,
          position: photo.position,
          width: photo.width,
          height: photo.height,
          byteSize: photo.byteSize,
          contentType: photo.contentType,
        })),
      },
      { status: 200 },
    ),
    shelter.refreshedCookie,
  );
};
