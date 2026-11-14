import {
  INDEX_POINTER_KEY,
  compareByFreshestConfirmed,
  deriveStalenessBand,
  parseIndex,
} from "@pawster/domain";
import type { IndexPointer } from "@pawster/domain";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { derivativeKey } from "../src/lib/photos/keys.ts";
import { seedAnimal } from "./support/animal.ts";
import { get, post } from "./support/http.ts";
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
  await env.DB.exec("DELETE FROM transformation_spends");
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

describe("deleting", () => {
  it("refuses to delete an animal's only photo", async () => {
    const { cookie, animalId } = await publishedAnimal(1);

    const response = await post(`/api/refugios/animales/${animalId}/fotos`, {}, { cookie });

    expect(response.status).toBe(409);
    expect(await photoOrder(animalId)).toEqual([photoId(animalId, 0)]);
  });

  it("promotes the next photo when the primary is deleted", async () => {
    const { cookie, animalId } = await publishedAnimal(3);

    const response = await post(
      `/api/refugios/animales/${animalId}/fotos`,
      { orden: [photoId(animalId, 1), photoId(animalId, 2)] },
      { cookie },
    );

    expect(response.status).toBe(303);
    expect(await photoOrder(animalId)).toEqual([photoId(animalId, 1), photoId(animalId, 2)]);
    expect(await env.MEDIA.head(await derivativeKey(digest(1), "digestThumbnail"))).not.toBeNull();
    expect(await env.MEDIA.head(await derivativeKey(digest(1), "socialPreview"))).not.toBeNull();
    // Promotion spends from the same monthly budget as uploads.
    const spent = await env.DB.prepare(
      "SELECT coalesce(sum(transformations), 0) AS n FROM transformation_spends",
    ).first<{ n: number }>();
    expect(spent!.n).toBe(2);
  });

  it("deletes a later photo without spending a transformation", async () => {
    const { cookie, animalId } = await publishedAnimal(3);

    await post(
      `/api/refugios/animales/${animalId}/fotos`,
      { orden: [photoId(animalId, 0), photoId(animalId, 2)] },
      { cookie },
    );

    expect(await photoOrder(animalId)).toEqual([photoId(animalId, 0), photoId(animalId, 2)]);
    expect(outbound.callsTo("cf.image")).toHaveLength(0);
  });
});

describe("what the listing sees", () => {
  it("moves a reordered animal to the freshest end and names the new primary's thumbnail", async () => {
    const { shelterId, cookie, animalId } = await publishedAnimal(2);
    const stale = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await env.DB.prepare("UPDATE animals SET last_confirmed_at = ? WHERE id = ?")
      .bind(stale.getTime(), animalId)
      .run();
    await seedAnimal({ id: "animal-2", shelterId, lastConfirmedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });

    await post(
      `/api/refugios/animales/${animalId}/fotos`,
      { orden: [photoId(animalId, 1), photoId(animalId, 0)] },
      { cookie },
    );

    const listing = [...(await currentIndex()).animals].sort(compareByFreshestConfirmed);
    expect(listing.map((animal) => animal.id)).toEqual([animalId, "animal-2"]);
    const moved = listing[0]!;
    expect(deriveStalenessBand(stale, new Date())).toBe("Stale");
    expect(deriveStalenessBand(moved.lastConfirmedAt, new Date())).toBe("Fresh");
    expect(moved.thumbnailKey).toBe(await derivativeKey(digest(1), "cardThumbnail"));
  });
});

describe("a bonded group", () => {
  it("confirms every member when one member's photos change", async () => {
    const { shelterId, cookie, animalId } = await publishedAnimal(2);
    const stale = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await seedAnimal({ id: "animal-2", shelterId, lastConfirmedAt: stale, bondedGroupId: "g1" });
    await env.DB.prepare("UPDATE animals SET last_confirmed_at = ?, bonded_group_id = 'g1' WHERE id = ?")
      .bind(stale.getTime(), animalId)
      .run();

    await post(
      `/api/refugios/animales/${animalId}/fotos`,
      { orden: [photoId(animalId, 1), photoId(animalId, 0)] },
      { cookie },
    );

    const partner = await env.DB.prepare("SELECT last_confirmed_at FROM animals WHERE id = 'animal-2'")
      .first<{ last_confirmed_at: number }>();
    expect(deriveStalenessBand(new Date(partner!.last_confirmed_at), new Date())).toBe("Fresh");
  });
});

describe("what is left alone", () => {
  it("purges no cache and deletes no derivative", async () => {
    const { cookie, animalId } = await publishedAnimal(2);
    const oldPrimaryPreview = await derivativeKey(digest(0), "socialPreview");
    await env.MEDIA.put(oldPrimaryPreview, new Uint8Array([1]));

    const before = outbound.calls.length;

    await post(
      `/api/refugios/animales/${animalId}/fotos`,
      { orden: [photoId(animalId, 1)] },
      { cookie },
    );

    // A purge would be a fetch to the Cloudflare API, which the interceptor records as a
    // violation because no vendor is registered for it.
    expect(outbound.violations).toEqual([]);
    expect(outbound.calls.slice(before).map((call) => call.vendor)).toEqual([
      "cf.image",
      "cf.image",
    ]);
    expect(await env.MEDIA.head(oldPrimaryPreview)).not.toBeNull();
  });
});

describe("who may", () => {
  it("answers 404 for another shelter's animal", async () => {
    const { cookie } = await publishedAnimal(2);
    await env.DB.prepare(
      "INSERT INTO shelters (id, slug, display_name, account_email, base_region, country_code, created_at) VALUES ('shelter-other', 'otro', 'Otro', 'otro@refugio.example', 'Miranda', 'VE', 0)",
    ).run();
    await seedAnimal({ id: "elsewhere", shelterId: "shelter-other", photoCount: 2 });

    const response = await post(
      `/api/refugios/animales/elsewhere/fotos`,
      { orden: [photoId("elsewhere", 1)] },
      { cookie },
    );

    expect(response.status).toBe(404);
    expect(await photoOrder("elsewhere")).toEqual([photoId("elsewhere", 0), photoId("elsewhere", 1)]);
  });
});

describe("the shelter's animal page", () => {
  it("offers a button that makes the second photo primary, and no delete on a lone photo", async () => {
    const { cookie, animalId } = await publishedAnimal(2);

    const html = await (await get(`/refugios/animales/${animalId}`, cookie)).text();
    const forms = [...html.matchAll(/<form method="post" action="[^"]*\/fotos">([\s\S]*?)<\/form>/g)]
      .map((match) => ({
        order: [...match[1]!.matchAll(/name="orden" value="([^"]+)"/g)].map((m) => m[1]),
        label: match[1]!.match(/<button[^>]*>([^<]+)</)![1],
      }));

    expect(forms).toContainEqual({
      label: "Hacer principal",
      order: [photoId(animalId, 1), photoId(animalId, 0)],
    });
    expect(forms).toContainEqual({ label: "Borrar", order: [photoId(animalId, 1)] });

    await post(`/api/refugios/animales/${animalId}/fotos`, { orden: [photoId(animalId, 1)] }, { cookie });
    const after = await (await get(`/refugios/animales/${animalId}?fotos`, cookie)).text();
    expect(after).toContain("Fotos guardadas.");
    expect(after).not.toContain(">Borrar<");
  });
});
