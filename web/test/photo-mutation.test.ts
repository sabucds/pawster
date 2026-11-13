import { INDEX_POINTER_KEY, parseIndex } from "@pawster/domain";
import type { IndexPointer } from "@pawster/domain";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { derivativeKey } from "../src/lib/photos/keys.ts";
import { seedAnimal } from "./support/animal.ts";
import { post } from "./support/http.ts";
import { clearShelterTables, signIn, verifyShelter } from "./support/shelter.ts";

/**
 * Issue #58: a shelter reorders or deletes an animal's photos after publishing.
 *
 * Everything goes through the endpoint a shelter's form posts to, and is observed where a
 * reader would observe it: the photo order the gallery reads, the objects in the media
 * bucket, and the filter index adopters download.
 */

const photoId = (animalId: string, position: number) =>
  `session-for-${animalId}-photo-${position}`;
const digest = (position: number) => `${"0".repeat(63)}${position}`;

async function photoOrder(animalId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM upload_session_photos WHERE session_id = ? ORDER BY position",
  )
    .bind(`session-for-${animalId}`)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

async function currentIndex() {
  const pointerObject = await env.MEDIA.get(INDEX_POINTER_KEY);
  const pointer = JSON.parse(await pointerObject!.text()) as IndexPointer;
  const object = await env.MEDIA.get(pointer.key);
  const text = await new Response(
    object!.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return parseIndex(text);
}

async function clearMedia(): Promise<void> {
  const listed = await env.MEDIA.list();
  if (listed.objects.length > 0) {
    await env.MEDIA.delete(listed.objects.map((object) => object.key));
  }
}

/** A signed-in, verified shelter with one animal holding `photoCount` photos. */
async function publishedAnimal(photoCount: number, animalId = "animal-1") {
  const { shelterId, cookie } = await signIn();
  await verifyShelter(shelterId);
  await seedAnimal({ id: animalId, shelterId, photoCount });
  return { shelterId, cookie, animalId };
}

beforeEach(async () => {
  await clearShelterTables();
  await clearMedia();
});

describe("reordering", () => {
  it("makes the photo moved first the primary and mints its digest thumbnail and social preview", async () => {
    const { cookie, animalId } = await publishedAnimal(3);

    const response = await post(
      `/api/refugios/animales/${animalId}/fotos`,
      { orden: [photoId(animalId, 1), photoId(animalId, 0), photoId(animalId, 2)] },
      { cookie },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `/refugios/animales/${animalId}?fotos`,
    );
    expect(await photoOrder(animalId)).toEqual([
      photoId(animalId, 1),
      photoId(animalId, 0),
      photoId(animalId, 2),
    ]);

    const transforms = outbound.callsTo("cf.image").map((call) => call.imageTransform);
    expect(transforms).toEqual([
      expect.objectContaining({ width: 144, height: 144 }),
      expect.objectContaining({ width: 1200, height: 630 }),
    ]);
    expect(await env.MEDIA.head(await derivativeKey(digest(1), "digestThumbnail"))).not.toBeNull();
    expect(await env.MEDIA.head(await derivativeKey(digest(1), "socialPreview"))).not.toBeNull();
  });
});
