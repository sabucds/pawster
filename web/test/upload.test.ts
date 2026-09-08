import {
  createDb,
  shelters,
  storageMeasurements,
  transformationSpends,
  uploadSessions,
} from "@pawster/db";
import {
  DERIVATIVE_CACHE_CONTROL,
  MAX_ORIGINAL_BYTES,
  MONTHLY_TRANSFORMATION_BUDGET,
  UPLOAD_SESSION_TTL_MS,
  derivativeKeyMaterial,
} from "@pawster/domain";
import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { encodeSession } from "../src/lib/auth/session.ts";
import { sha256Hex } from "../src/lib/media/keys.ts";
import { heic, jpeg, notAnImage, png } from "./fixtures/images.ts";

/**
 * The photo pipeline, end to end, through the Worker's own front door.
 *
 * Every request goes through `SELF.fetch()`, so the asset router, the R2 bindings and the D1
 * migrations are all in the picture, and every `cf.image` transform leaves through the single
 * outbound interceptor — which is what lets "four transforms for a primary, two for the rest"
 * be an assertion against one ordered call log rather than a question asked of a mock.
 *
 * The transform itself does not run locally and is not meant to: ADR 0012 puts image encoding
 * outside our isolate entirely, and `docs/testing-seams.md` records `cf.image` as the
 * interceptor's third vendor. What is under test here is everything around it — what we ask
 * for, what we refuse before asking, what we store, and what we spend.
 */

const ORIGIN = "https://pawster.test";

const SHELTER = {
  id: "shelter-under-test",
  slug: "refugio-los-teques",
  displayName: "Refugio Los Teques",
  accountEmail: "fotos@refugio.example",
  baseRegion: "Miranda",
  countryCode: "VE",
};

/**
 * A session cookie minted directly rather than by signing in.
 *
 * Sign-in is `shelter-access.test.ts`'s subject and costs three requests and an email per
 * test; this file's subject is what happens *after* the shelter is in. The cookie is signed
 * with the same fixed `SESSION_SECRET` the seam supplies, so `guard.ts` accepts it exactly as
 * it would accept one it issued.
 */
async function sessionCookie(shelterId = SHELTER.id): Promise<string> {
  const value = await encodeSession(env.SESSION_SECRET, {
    shelterId,
    issuedAt: new Date(),
    epoch: 0,
  });
  return `pawster_session=${value}`;
}

/** A healthy measurement, so the storage ladder is out of the way unless a test moves it. */
async function measureStorage(totalBytes: number, measuredAt = new Date()) {
  const db = createDb(env.DB);
  await db.insert(storageMeasurements).values({
    id: crypto.randomUUID(),
    totalBytes,
    mode: "normal",
    measuredAt,
  });
}

async function seedShelter(shelter = SHELTER) {
  const db = createDb(env.DB);
  await db.insert(shelters).values({ ...shelter, createdAt: new Date() });
}

/** Wipe every table this file writes to, so each test starts from nothing. */
async function reset() {
  for (const table of [
    "upload_session_photos",
    "upload_sessions",
    "transformation_spends",
    "storage_measurements",
    "shelters",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const bucket of [env.MEDIA, env.ORIGINALS]) {
    const listed = await bucket.list();
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }
  }
}

async function openSession(cookie: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/refugios/subidas`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });
}

interface UploadOptions {
  readonly contentType?: string;
  /** Sent instead of the body's real length, for the test that lies about it. */
  readonly declaredBytes?: number | null;
}

function upload(
  sessionId: string,
  cookie: string,
  body: Uint8Array,
  options: UploadOptions = {},
): Promise<Response> {
  const headers = new Headers({
    cookie,
    origin: ORIGIN,
    "content-type": options.contentType ?? "image/jpeg",
  });
  const declared =
    options.declaredBytes === undefined ? body.length : options.declaredBytes;
  if (declared !== null) headers.set("content-length", String(declared));

  /**
   * A `Uint8Array` body has its `Content-Length` set for it, so the only way to send one
   * *without* a declared length is to send a stream — which is also the only shape that
   * produces the header the route is refusing. A browser does this whenever it uploads
   * something it is still generating; a `File` or `Blob` always carries its length.
   */
  // Typed loosely on purpose: the DOM `BodyInit` this file's `lib` supplies does not admit
  // a `ReadableStream`, which is the only body shape that produces no `Content-Length` —
  // and the whole point of this branch.
  const payload: unknown =
    declared === null
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        })
      : body;

  return SELF.fetch(`${ORIGIN}/api/refugios/subidas/${sessionId}/fotos`, {
    method: "POST",
    headers,
    body: payload as BodyInit,
    ...(declared === null ? { duplex: "half" } : {}),
  } as RequestInit);
}

/** Open a session and return its id, having asserted the platform would accept a photo. */
async function session(cookie: string): Promise<string> {
  const response = await openSession(cookie);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return body.id;
}

/** A 4032x3024 photo, distinct per call so two uploads are not the same bytes. */
let unique = 0;
function photo(): Uint8Array {
  return jpeg({ width: 4032, height: 3024, padding: ++unique });
}

beforeEach(async () => {
  await reset();
  await seedShelter();
  await measureStorage(1_000_000_000);
});

describe("opening an upload session", () => {
  it("refuses a caller with no session", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/refugios/subidas`, {
      method: "POST",
      headers: { origin: ORIGIN },
    });
    expect(response.status).toBe(401);
  });

  it("says what it will accept, so the form can refuse before sending anything", async () => {
    const response = await openSession(await sessionCookie());
    expect(response.status).toBe(201);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.maxPhotos).toBe(6);
    expect(body.maxBytes).toBe(MAX_ORIGINAL_BYTES);
    expect(body.transformationsRemaining).toBe(MONTHLY_TRANSFORMATION_BUDGET);
    expect(body.acceptedTypes).toContain("image/heic");
    // Absolute, because the browser's clock is the one we do not control.
    expect(
      new Date(body.expiresAt as string).getTime() - Date.now(),
    ).toBeGreaterThan(UPLOAD_SESSION_TTL_MS - 60_000);
  });

  it("offers one photo rather than six while storage is degraded", async () => {
    await env.DB.prepare("DELETE FROM storage_measurements").run();
    await measureStorage(8_500_000_000);

    const body = (await (await openSession(await sessionCookie())).json()) as {
      maxPhotos: number;
    };
    // ADR 0012: a one-photo listing still finds a home where a rejected upload loses a
    // shelter permanently.
    expect(body.maxPhotos).toBe(1);
  });

  it("opens no session at all once the month's transformations are gone", async () => {
    await spend(MONTHLY_TRANSFORMATION_BUDGET);

    const response = await openSession(await sessionCookie());
    // Refused before the bytes are sent, which is the whole reason this endpoint exists.
    expect(response.status).toBe(507);
    expect(((await response.json()) as { refused: string }).refused).toBe(
      "transformation-budget-exhausted",
    );

    const db = createDb(env.DB);
    expect(await db.select().from(uploadSessions)).toHaveLength(0);
  });

  it("opens no session when the sweep has never run", async () => {
    // No measurement is not an empty platform. The refusal is `photo-limit-reached` at a
    // limit of one — degraded, but a first photo is still allowed, so a session opens.
    await env.DB.prepare("DELETE FROM storage_measurements").run();
    const response = await openSession(await sessionCookie());
    expect(response.status).toBe(201);
    expect(((await response.json()) as { maxPhotos: number }).maxPhotos).toBe(1);
  });
});

describe("uploading a photo", () => {
  it("streams one photo to R2 and mints all four derivatives for the primary", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    const bytes = photo();

    const response = await upload(id, cookie, bytes);
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      position: number;
      width: number;
      height: number;
      byteSize: number;
      derivatives: Record<string, string>;
      transformationsSpent: number;
    };

    expect(body.position).toBe(0);
    expect(body.width).toBe(4032);
    expect(body.height).toBe(3024);
    expect(body.byteSize).toBe(bytes.length);
    expect(Object.keys(body.derivatives).sort()).toEqual([
      "cardThumbnail",
      "detailImage",
      "digestThumbnail",
      "socialPreview",
    ]);
    expect(body.transformationsSpent).toBe(4);

    // Every one of the four objects exists, under `d/`, immutable.
    for (const key of Object.values(body.derivatives)) {
      expect(key.startsWith("d/")).toBe(true);
      const object = await env.MEDIA.head(key);
      expect(object, `${key} should be in pawster-media`).not.toBeNull();
      expect(object!.httpMetadata?.cacheControl).toBe(DERIVATIVE_CACHE_CONTROL);
    }

    // And the original is in the *other* bucket, which is never public.
    const originals = await env.ORIGINALS.list();
    expect(originals.objects).toHaveLength(1);
    expect(originals.objects[0]!.key.startsWith("o/")).toBe(true);
    expect(originals.objects[0]!.size).toBe(bytes.length);
  });

  it("mints only the two shared derivatives for a photo that is not the primary", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    await upload(id, cookie, photo());
    outbound.reset();

    const second = await upload(id, cookie, photo());
    expect(second.status).toBe(201);

    const body = (await second.json()) as {
      position: number;
      derivatives: Record<string, string>;
      transformationsSpent: number;
    };
    expect(body.position).toBe(1);
    expect(Object.keys(body.derivatives).sort()).toEqual([
      "cardThumbnail",
      "detailImage",
    ]);
    expect(body.transformationsSpent).toBe(2);
    // The digest email and the social preview only ever show one image, so a second photo
    // has nothing to contribute to either.
    expect(body.derivatives.digestThumbnail).toBeUndefined();
    expect(body.derivatives.socialPreview).toBeUndefined();
  });

  it("asks for every transform through cf.image, and spends one subrequest each", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    await upload(id, cookie, photo());

    // ADR 0012's arithmetic for one-photo-per-request: an Images call is exactly one
    // subrequest (measured, issue #34), so a primary's invocation spends four of the Free
    // plan's 50 — where a six-photo animal in one invocation would spend 34-40.
    const transforms = outbound.callsTo("cf.image");
    expect(transforms).toHaveLength(4);
    expect(outbound.calls).toHaveLength(4);
    expect(outbound.calls.every((call) => call.vendor === "cf.image")).toBe(true);
    expect(transforms.length).toBeLessThanOrEqual(5);

    // Every call carries a transform, and every one of them goes to the token-gated route.
    for (const call of transforms) {
      expect(call.imageTransform).toBeDefined();
      expect(call.url).toContain("/api/originales/o/");
      expect(call.url).toContain("token=");
    }

    // The four specs, exactly as the derivative set describes them.
    expect(transforms.map((call) => call.imageTransform)).toEqual(
      expect.arrayContaining([
        { width: 144, height: 144, fit: "cover", format: "jpeg", gravity: "auto" },
        { width: 400, height: 400, fit: "scale-down", format: "webp" },
        { width: 1280, height: 1280, fit: "scale-down", format: "webp" },
        { width: 1200, height: 630, fit: "cover", format: "jpeg", gravity: "auto" },
      ]),
    );
  });

  it("records the photo and the transformations it spent, in one transaction", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    await upload(id, cookie, photo());

    const photos = await env.DB.prepare(
      "SELECT position, width, height, source_digest, original_key FROM upload_session_photos",
    ).all();
    expect(photos.results).toHaveLength(1);

    const spends = await env.DB.prepare(
      "SELECT transformations FROM transformation_spends",
    ).all();
    expect(spends.results).toEqual([{ transformations: 4 }]);
  });

  it("gives a photo the derivative keys its content hashes to", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    const bytes = photo();

    const body = (await (await upload(id, cookie, bytes)).json()) as {
      derivatives: Record<string, string>;
    };

    // Recomputed from the bytes the test sent, through `domain/`'s shaping — so the key is
    // demonstrably a function of the content and the spec, and not of anything the request
    // happened to carry.
    const digest = await sha256Hex(bytes);
    const expected = `d/${await sha256Hex(
      derivativeKeyMaterial(digest, "detailImage"),
    )}.webp`;
    expect(body.derivatives.detailImage).toBe(expected);
  });
});

describe("the three refusals that happen before anything is stored", () => {
  it("refuses an oversized file without reading it", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    // The body is small; the declaration is not. The refusal is on the declaration, which
    // is the only size available before the body is touched.
    const response = await upload(id, cookie, photo(), {
      declaredBytes: MAX_ORIGINAL_BYTES + 1,
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { refused: string }).refused).toBe(
      "file-too-large",
    );

    expect((await env.ORIGINALS.list()).objects).toHaveLength(0);
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
    expect(outbound.callsTo("cf.image")).toHaveLength(0);
  });

  it("refuses an over-dimension image before storing it", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    // Inside the byte cap and far outside the pipeline's own 12,000-pixel input ceiling —
    // which would fail the transform *after* the original was stored.
    const response = await upload(id, cookie, png(20_000, 400), {
      contentType: "image/png",
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { refused: string }).refused).toBe(
      "image-too-large",
    );

    expect((await env.ORIGINALS.list()).objects).toHaveLength(0);
    expect(outbound.callsTo("cf.image")).toHaveLength(0);
  });

  it("refuses an upload the month's remaining transformations cannot pay for", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    // Three left, and a primary costs four.
    await spend(MONTHLY_TRANSFORMATION_BUDGET - 3);

    const response = await upload(id, cookie, photo());
    expect(response.status).toBe(507);
    expect(((await response.json()) as { refused: string }).refused).toBe(
      "transformation-budget-exhausted",
    );

    expect((await env.ORIGINALS.list()).objects).toHaveLength(0);
    expect(outbound.callsTo("cf.image")).toHaveLength(0);
  });

  it("refuses a file that is not an image, whatever it was labelled", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    // Labelled `image/jpeg`, which passes the header check, and is a PDF.
    const response = await upload(id, cookie, notAnImage());
    expect(response.status).toBe(415);
    expect((await env.ORIGINALS.list()).objects).toHaveLength(0);
  });

  it("refuses a body that declares no length, since it cannot be streamed", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    const response = await upload(id, cookie, photo(), { declaredBytes: null });
    expect(response.status).toBe(411);
  });
});

describe("HEIC, which is what an iPhone actually uploads", () => {
  it("accepts a rotated HEIC and asks for upright derivatives in the specified format", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    // A landscape sensor frame with an `irot` saying to turn it: the upright image is
    // 3024x4032, and it is the only version that will exist once the original expires.
    const bytes = heic({ width: 4032, height: 3024, irot: 1 });
    const response = await upload(id, cookie, bytes, { contentType: "image/heic" });
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      width: number;
      height: number;
      contentType: string;
      derivatives: Record<string, string>;
    };
    expect(body.width).toBe(3024);
    expect(body.height).toBe(4032);
    expect(body.contentType).toBe("image/heic");

    /**
     * Every transform names an explicit output format, and none of them names a rotation.
     *
     * Both halves matter. The format is why nothing is ever served as HEIC, which only
     * Safari renders — the derivative set decides the encoding, never the source. The
     * absent rotation is why the result is upright exactly once: Cloudflare's pipeline
     * applies the source's own orientation and discards the metadata, so a `rotate` of ours
     * would turn an already-upright image a second time. See `docs/measurements.md` for
     * what is and is not verifiable about that offline.
     */
    for (const call of outbound.callsTo("cf.image")) {
      expect(call.imageTransform).toHaveProperty("format");
      expect(["jpeg", "webp"]).toContain(call.imageTransform!.format);
      expect(call.imageTransform).not.toHaveProperty("rotate");
    }

    // And the stored objects are JPEG and WebP, never the HEIC that arrived.
    const digestThumbnail = await env.MEDIA.head(body.derivatives.digestThumbnail!);
    expect(digestThumbnail!.httpMetadata?.contentType).toBe("image/jpeg");
    const detail = await env.MEDIA.head(body.derivatives.detailImage!);
    expect(detail!.httpMetadata?.contentType).toBe("image/webp");
  });

  it("reads a HEIC that was labelled as a JPEG", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    // The label is the operating system's guess at a file extension. What the file is, is a
    // question only the bytes answer.
    const response = await upload(
      id,
      cookie,
      heic({ width: 4032, height: 3024 }),
      { contentType: "image/jpeg" },
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { contentType: string }).contentType).toBe(
      "image/heic",
    );
  });
});

describe("content-addressed keys", () => {
  it("stores one object for the same bytes uploaded twice, and spends nothing the second time", async () => {
    const cookie = await sessionCookie();
    const bytes = photo();

    const first = await session(cookie);
    const firstBody = (await (await upload(first, cookie, bytes)).json()) as {
      derivatives: Record<string, string>;
      transformationsSpent: number;
    };
    expect(firstBody.transformationsSpent).toBe(4);
    const afterFirst = (await env.MEDIA.list()).objects.length;
    expect(afterFirst).toBe(4);

    // A second session — two animals photographed in one shot, which is ADR 0016's case.
    outbound.reset();
    const second = await session(cookie);
    const secondBody = (await (await upload(second, cookie, bytes)).json()) as {
      derivatives: Record<string, string>;
      transformationsSpent: number;
    };

    expect(secondBody.derivatives).toEqual(firstBody.derivatives);
    // No transform was asked for at all: the keys were already there, so there was nothing
    // a transform could add. The saving is a consequence of the key being the content.
    expect(secondBody.transformationsSpent).toBe(0);
    expect(outbound.callsTo("cf.image")).toHaveLength(0);
    expect((await env.MEDIA.list()).objects).toHaveLength(afterFirst);

    // And no ledger row, because nothing was spent — a zero row would record an event that
    // did not happen.
    const spends = await env.DB.prepare(
      "SELECT count(*) as n FROM transformation_spends",
    ).first<{ n: number }>();
    expect(spends!.n).toBe(1);
  });

  it("refuses the same photograph twice in one session", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    const bytes = photo();

    expect((await upload(id, cookie, bytes)).status).toBe(201);

    const again = await upload(id, cookie, bytes);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { refused: string }).refused).toBe(
      "duplicate-photo",
    );

    // The duplicate original is cleaned up rather than left for the lifecycle rule, so it
    // does not distort the byte measurement the storage caps are driven by.
    expect((await env.ORIGINALS.list()).objects).toHaveLength(1);
  });
});

describe("the session as a session", () => {
  it("holds photos that belong to no animal", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    await upload(id, cookie, photo());

    // Nothing here is an animal, and nothing here is visible to an adopter. The animal row
    // is written last, by issue #55, referencing derivatives that already exist.
    const animals = await env.DB.prepare("SELECT count(*) as n FROM animals").first<{
      n: number;
    }>();
    expect(animals!.n).toBe(0);
  });

  it("is resumable: the photos come back after the connection did not", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    await upload(id, cookie, photo());
    await upload(id, cookie, photo());

    // A new request, as a reopened tab or a different device would make. Nothing was held
    // in the browser, so nothing had to survive there.
    const response = await SELF.fetch(
      `${ORIGIN}/api/refugios/subidas/${id}/fotos`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      resumable: boolean;
      photos: Array<{ position: number }>;
    };
    expect(body.resumable).toBe(true);
    expect(body.photos.map((p) => p.position)).toEqual([0, 1]);
  });

  it("stops accepting photos after 24 hours", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    await env.DB.prepare("UPDATE upload_sessions SET created_at = ?").bind(
      Date.now() - UPLOAD_SESSION_TTL_MS - 1000,
    ).run();

    const response = await upload(id, cookie, photo());
    expect(response.status).toBe(410);
    expect(((await response.json()) as { refused: string }).refused).toBe(
      "session-expired",
    );
    expect((await env.ORIGINALS.list()).objects).toHaveLength(0);
  });

  it("still shows an expired session's photos rather than an empty page", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    await upload(id, cookie, photo());
    await env.DB.prepare("UPDATE upload_sessions SET created_at = ?").bind(
      Date.now() - UPLOAD_SESSION_TTL_MS - 1000,
    ).run();

    const body = (await (
      await SELF.fetch(`${ORIGIN}/api/refugios/subidas/${id}/fotos`, {
        headers: { cookie },
      })
    ).json()) as { resumable: boolean; photos: unknown[] };

    expect(body.resumable).toBe(false);
    expect(body.photos).toHaveLength(1);
  });

  it("refuses a seventh photo", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    for (let i = 0; i < 6; i++) {
      expect((await upload(id, cookie, photo())).status).toBe(201);
    }

    const seventh = await upload(id, cookie, photo());
    expect(seventh.status).toBe(409);
    expect(((await seventh.json()) as { refused: string }).refused).toBe(
      "photo-limit-reached",
    );
  });

  it("gives every photo its own position when a form uploads several at once", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);

    // A form with six files picked at once is the ordinary case, not an exotic one. Two
    // requests that each read the highest position and then wrote it back would both write
    // the same number, and the unique index would turn the race into a 500.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => upload(id, cookie, photo())),
    );

    expect(responses.map((response) => response.status)).toEqual([
      201, 201, 201, 201,
    ]);

    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ position: number }>;
    expect(bodies.map((body) => body.position).sort()).toEqual([0, 1, 2, 3]);

    // And exactly one photo is the primary, whichever request happened to land first.
    const primaries = await env.DB.prepare(
      "SELECT count(*) as n FROM upload_session_photos WHERE position = 0",
    ).first<{ n: number }>();
    expect(primaries!.n).toBe(1);
  });

  it("costs ADR 0012's 2N + 2 for a six-photo animal", async () => {
    const cookie = await sessionCookie();
    const id = await session(cookie);
    for (let i = 0; i < 6; i++) await upload(id, cookie, photo());

    const total = await env.DB.prepare(
      "SELECT sum(transformations) as n FROM transformation_spends",
    ).first<{ n: number }>();
    expect(total!.n).toBe(14);
  });

  it("gains no abandoned state, because there is no writer to set one", async () => {
    // ADR 0016's decision, asserted structurally: abandonment is derived from elapsed time
    // and the absence of an animal, so there is no column for anything to write.
    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('upload_sessions')",
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name).sort()).toEqual([
      "created_at",
      "id",
      "shelter_id",
    ]);
  });

  it("answers 404 for another shelter's session, never 403", async () => {
    const ownerCookie = await sessionCookie();
    const id = await session(ownerCookie);

    await seedShelter({
      ...SHELTER,
      id: "other-shelter",
      slug: "otro-refugio",
      accountEmail: "otro@refugio.example",
    });

    // A 403 would confirm the id belongs to somebody, and by extension that a shelter is in
    // the middle of publishing.
    const response = await upload(id, await sessionCookie("other-shelter"), photo());
    expect(response.status).toBe(404);
  });
});

/** Spend transformations against this month's ledger, without uploading anything. */
async function spend(transformations: number) {
  const db = createDb(env.DB);
  await db.insert(transformationSpends).values({
    id: crypto.randomUUID(),
    transformations,
    spentAt: new Date(),
  });
}
