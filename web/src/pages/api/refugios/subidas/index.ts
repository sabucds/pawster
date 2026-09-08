/**
 * Open an Upload Session, and say up front what it will accept.
 *
 * This endpoint exists because of one word in issue #54's acceptance criteria: an upload
 * over the month's remaining transformation budget must be refused **before the bytes are
 * sent**. A refusal on the upload request itself is already too late in the sense that
 * matters — the shelter has spent its connection sending a 4 MB photo over a patchy link to
 * be told the platform could not have taken it. So the budget, the storage mode and the
 * caps are all answered here, before the first photo moves.
 *
 * It is a pre-flight and **not a promise**. Between this answer and the upload, another
 * shelter may spend the last of the month's transformations; the upload path therefore
 * re-checks everything, and this response is advice a form can act on rather than a
 * reservation. Reserving budget would need a hold, a hold needs an expiry, and an expiry
 * needs a writer to enforce it — which is the shape ADR 0016 refuses for abandonment and
 * refuses here for the same reason.
 */

import { createDb } from "@pawster/db";
import {
  ACCEPTED_ORIGINAL_TYPES,
  MAX_ORIGINAL_BYTES,
  MAX_ORIGINAL_DIMENSION,
  MAX_ORIGINAL_PIXELS,
  MONTHLY_TRANSFORMATION_BUDGET,
  UPLOAD_SESSION_TTL_MS,
  deriveStorageMode,
  photoLimitFor,
  refuseUpload,
} from "@pawster/domain";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { authenticate } from "../../../../lib/auth/guard.ts";
import {
  createUploadSession,
  latestStorageMeasurement,
  transformationsUsedThisMonth,
} from "../../../../lib/media/store.ts";
import { refusalResponse, withRefreshedCookie } from "../../../../lib/media/responses.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);
  const now = new Date();

  const shelter = await authenticate(request, db, env, now);
  if (!shelter) return new Response(null, { status: 401 });

  const [storage, used] = await Promise.all([
    latestStorageMeasurement(db),
    transformationsUsedThisMonth(db, now),
  ]);

  /**
   * The session's own refusals, asked of a session that does not exist yet: an
   * `photosInSession` of zero and a `createdAt` of now make this the question "could this
   * shelter upload a primary photo right now", which is the only question worth answering
   * before opening a session. Opening one the platform cannot accept a single photo into
   * would be a row written to be abandoned.
   */
  const refusal = refuseUpload(
    {
      contentType: ACCEPTED_ORIGINAL_TYPES[0]!,
      declaredBytes: null,
      sessionCreatedAt: now,
      photosInSession: 0,
      transformationsUsedThisMonth: used,
      storage,
    },
    now,
  );
  if (refusal) return refusalResponse(refusal, shelter.refreshedCookie);

  const id = crypto.randomUUID();
  await createUploadSession(db, {
    id,
    shelterId: shelter.shelterId,
    createdAt: now,
  });

  return withRefreshedCookie(
    Response.json(
      {
        id,
        /**
         * Absolute rather than a duration, because the browser holding this is the one
         * thing in the exchange whose clock we do not control — and a shelter that leaves a
         * tab open for six hours must not be told it still has 24.
         */
        expiresAt: new Date(now.getTime() + UPLOAD_SESSION_TTL_MS).toISOString(),
        /**
         * What this session will actually take, which under a degraded storage mode is one
         * photo rather than six. Sent so the form can say so at the start instead of
         * accepting five photos and refusing four of them.
         */
        maxPhotos: photoLimitFor(deriveStorageMode(storage, now)),
        maxBytes: MAX_ORIGINAL_BYTES,
        maxDimension: MAX_ORIGINAL_DIMENSION,
        maxPixels: MAX_ORIGINAL_PIXELS,
        acceptedTypes: ACCEPTED_ORIGINAL_TYPES,
        /**
         * The month's remaining transformations, in transformations rather than in photos,
         * because what a photo costs depends on whether it is the primary. A form that
         * wants to know how many photos it can still add can do the arithmetic; a number
         * that pretended photos were interchangeable would be wrong for the first one.
         */
        transformationsRemaining: MONTHLY_TRANSFORMATION_BUDGET - used,
      },
      { status: 201 },
    ),
    shelter.refreshedCookie,
  );
};
