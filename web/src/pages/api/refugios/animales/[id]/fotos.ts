/**
 * Reorder or delete a published animal's photos (issue #58).
 *
 * A form post with one repeated field, `orden`: the ids of the photos to keep, in the order
 * to keep them. Leaving a photo out deletes it. The shelter's animal page builds each button
 * as its own form carrying the finished order, so this endpoint holds no "move up" or
 * "delete" logic of its own. See `lib/photos/arrange.ts` for what happens to the photos.
 *
 * Another shelter's animal answers 404 rather than 403, as every shelter endpoint does.
 */

import { createDb } from "@pawster/db";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { findAnimal } from "../../../../../lib/animals/store.ts";
import { authenticate } from "../../../../../lib/auth/guard.ts";
import { regenerateForAct } from "../../../../../lib/listing/regenerate.ts";
import { arrangePhotos } from "../../../../../lib/photos/arrange.ts";
import { withRefreshedCookie } from "../../../../../lib/photos/responses.ts";

export const prerender = false;

const REFUSAL_STATUS = { "invalid-order": 400, "last-photo": 409 } as const;

export const POST: APIRoute = async ({ request, params }) => {
  const db = createDb(env.DB);
  const now = new Date();

  const shelter = await authenticate(request, db, env, now);
  if (!shelter) return new Response(null, { status: 401 });

  const animal = params.id ? await findAnimal(db, params.id) : null;
  if (!animal || animal.shelterId !== shelter.shelterId) {
    return new Response(null, { status: 404 });
  }

  const order = (await request.formData()).getAll("orden").map(String);
  const arranged = await arrangePhotos(env, db, animal, order, now);
  if (!arranged.ok) {
    return withRefreshedCookie(
      new Response(null, { status: REFUSAL_STATUS[arranged.refusal] }),
      shelter.refreshedCookie,
    );
  }

  /**
   * Always regenerated. A reorder is a Confirmation, so it moves the animal in the
   * freshest-confirmed listing order even when the primary is unchanged, and a new primary
   * changes the thumbnail the index names (ADR 0012, ADR 0018).
   */
  const regenerated = await regenerateForAct({ db, media: env.MEDIA, now });

  return withRefreshedCookie(
    new Response(null, {
      status: 303,
      headers: {
        location:
          regenerated === null
            ? `/refugios/animales/${animal.id}?fotos&listado=pendiente`
            : `/refugios/animales/${animal.id}?fotos`,
      },
    }),
    shelter.refreshedCookie,
  );
};
