/**
 * Reordering and deleting a published animal's photos (issue #58, ADR 0012's "photo
 * mutation after publish").
 *
 * Both are one operation: the shelter names the photos it wants to keep, in the order it
 * wants them. A reorder names all of them; a delete leaves one out. Position 0 is the
 * primary, so either can change which photo is primary, and the new primary needs the two
 * derivatives only a primary has.
 *
 * ## Where promotion transforms from
 *
 * ADR 0012 says promotion "must read from R2 - server-side", because the original is gone
 * seven days after upload. So the source is the photo's own `detailImage`, the 1280px
 * derivative every photo already has, fetched from the public media origin. Both target
 * derivatives are smaller than it, and their keys are still `derivativeKey(sourceDigest,
 * name)`, so every reader finds them exactly as it finds an upload-time one.
 *
 * ## What is deliberately not done
 *
 * Nothing under `d/` is deleted and no cache is purged. The old primary's derivatives and a
 * deleted photo's derivatives become unreferenced, and ADR 0016's nightly sweep collects
 * them. A deleted photo's original, if it still exists, expires with the 7-day lifecycle rule.
 */

import type { Database } from "@pawster/db";
import { animals, transformationSpends, uploadSessionPhotos } from "@pawster/db";
import { MIN_PHOTOS_PER_ANIMAL, derivativesFor } from "@pawster/domain";
import { eq, sql } from "drizzle-orm";
import { derivativeKey } from "./keys.ts";
import { mintDerivatives } from "./pipeline.ts";
import { listSessionPhotos } from "./store.ts";

/** Why an arrangement was refused. */
export type ArrangeRefusal =
  /** The order named a photo twice, or a photo this animal does not have. */
  | "invalid-order"
  /** The order would leave the animal with fewer photos than `domain/` allows. */
  | "last-photo";

export interface ArrangePlatform {
  readonly MEDIA: R2Bucket;
  readonly MEDIA_PUBLIC_ORIGIN: string;
}

/**
 * Keep exactly the photos in `order`, in that order, and confirm the animal.
 *
 * Every arrangement is a Confirmation: `CONTEXT.md` defines one as "a shelter's deliberate
 * write to one animal", and ADR 0012 names the reorder explicitly. A delete is treated the
 * same way, since it is just as deliberate. `matchableSince` does not move.
 *
 * The caller regenerates the filter index afterwards, as every other act does (ADR 0018).
 */
export async function arrangePhotos(
  platform: ArrangePlatform,
  db: Database,
  animal: { readonly id: string; readonly uploadSessionId: string },
  order: readonly string[],
  now: Date,
): Promise<{ ok: true } | { ok: false; refusal: ArrangeRefusal }> {
  const rows = await listSessionPhotos(db, animal.uploadSessionId);
  const byId = new Map(rows.map((row) => [row.id, row]));

  if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
    return { ok: false, refusal: "invalid-order" };
  }
  if (order.length < MIN_PHOTOS_PER_ANIMAL) {
    return { ok: false, refusal: "last-photo" };
  }

  const newPrimary = byId.get(order[0]!)!;
  let transformationsSpent = 0;
  if (newPrimary.id !== rows[0]?.id) {
    const additional = new Set(derivativesFor("additional"));
    const source = `${platform.MEDIA_PUBLIC_ORIGIN.replace(/\/+$/, "")}/${await derivativeKey(newPrimary.sourceDigest, "detailImage")}`;
    ({ transformationsSpent } = await mintDerivatives(
      platform.MEDIA,
      source,
      newPrimary.sourceDigest,
      derivativesFor("primary").filter((name) => !additional.has(name)),
    ));
  }

  const kept = new Set(order);
  const removed = rows.filter((row) => !kept.has(row.id));

  /**
   * One transaction, and positions are written twice. `(session_id, position)` is unique, so
   * moving photo B into position 0 while photo A still holds it would fail halfway. Parking
   * every kept photo at a negative position first leaves no collision for the second pass.
   */
  await db.batch([
    db.update(animals).set({ lastConfirmedAt: now }).where(eq(animals.id, animal.id)),
    ...removed.map((row) =>
      db.delete(uploadSessionPhotos).where(eq(uploadSessionPhotos.id, row.id)),
    ),
    ...order.map((id, position) =>
      db
        .update(uploadSessionPhotos)
        .set({ position: -1 - position })
        .where(eq(uploadSessionPhotos.id, id)),
    ),
    db
      .update(uploadSessionPhotos)
      .set({ position: sql`-1 - ${uploadSessionPhotos.position}` })
      .where(eq(uploadSessionPhotos.sessionId, animal.uploadSessionId)),
    ...(transformationsSpent === 0
      ? []
      : [
          db.insert(transformationSpends).values({
            id: crypto.randomUUID(),
            transformations: transformationsSpent,
            spentAt: now,
          }),
        ]),
  ]);

  return { ok: true };
}
