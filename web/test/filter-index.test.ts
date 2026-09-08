import {
  createDb,
  shelterContactPoints,
  shelters,
  uploadSessionPhotos,
} from "@pawster/db";
import {
  INDEX_POINTER_KEY,
  INDEX_PREFIX,
  SUPERSEDED_INDEX_GRACE_MS,
  parseIndex,
} from "@pawster/domain";
import type { IndexPointer } from "@pawster/domain";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { regenerateIndex } from "../src/lib/listing/regenerate.ts";
import { mintAdminLink } from "../src/lib/verification/link.ts";
import { seedAnimal, seedUploadSession } from "./support/animal.ts";
import { post } from "./support/http.ts";
import {
  clearShelterTables,
  decideShelter,
  signIn,
  verifyShelter,
} from "./support/shelter.ts";

/**
 * The regenerator, against a real local D1 with the real migrations applied and a real R2.
 * Nothing here is faked: the four clauses are read out of three tables, the bytes are
 * gzipped by the platform's own `CompressionStream`, and the objects are listed back out of
 * the bucket the publish path writes to.
 */

const NOW = new Date("2026-09-08T12:00:00.000Z");

/** A verified shelter with one contact point, which is the state that lists anything. */
async function seedListableShelter(
  id = "shelter-1",
  region = "Miranda",
): Promise<void> {
  const db = createDb(env.DB);
  await db.insert(shelters).values({
    id,
    slug: `refugio-${id}`,
    displayName: `Refugio ${id}`,
    accountEmail: `hola@${id}.example`,
    baseRegion: region,
    countryCode: "VE",
    createdAt: new Date("2026-01-01"),
  });
  await db.insert(shelterContactPoints).values({
    id: `contact-${id}`,
    shelterId: id,
    kind: "whatsapp",
    value: "+58 412 5550001",
    position: 0,
    createdAt: new Date("2026-01-01"),
  });
  await verifyShelter(id);
}

async function regenerate(now: Date = NOW) {
  return await regenerateIndex({ db: createDb(env.DB), media: env.MEDIA, now });
}

/** The index the pointer currently names, decoded. */
async function currentIndex() {
  const pointerObject = await env.MEDIA.get(INDEX_POINTER_KEY);
  const pointer = JSON.parse(await pointerObject!.text()) as IndexPointer;
  const object = await env.MEDIA.get(pointer.key);
  /**
   * Decompressed by hand, because `R2Object.text()` hands back the stored bytes rather than
   * applying the `Content-Encoding` the object carries. That is the right behaviour for a
   * store and it is why the assertion about the header below is separate from this: what a
   * browser gets is a matter of the header R2 serves, which is ADR 0018's third open
   * measurement and cannot be settled inside the isolate.
   */
  const text = await new Response(
    object!.body.pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return { pointer, index: parseIndex(text) };
}

async function clearMedia(): Promise<void> {
  const listed = await env.MEDIA.list();
  if (listed.objects.length > 0) {
    await env.MEDIA.delete(listed.objects.map((object) => object.key));
  }
}

beforeEach(async () => {
  await clearShelterTables();
  await clearMedia();
});

describe("what reaches the index", () => {
  it("carries a listed animal, under i/, found through the pointer", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1", name: "Canela" });

    const result = await regenerate();
    const { pointer, index } = await currentIndex();

    expect(result.key.startsWith(INDEX_PREFIX)).toBe(true);
    expect(pointer.key).toBe(result.key);
    expect(index.animals.map((animal) => animal.name)).toEqual(["Canela"]);
  });

  /**
   * The four clauses, one test each, each with exactly one clause failing — so a test that
   * passes is observing the clause it names rather than any of the other three.
   */
  it("withholds an animal that is not Available", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1", availability: "Adopted" });

    expect((await regenerate()).animalCount).toBe(0);
  });

  it("withholds an animal whose shelter has no verification entry", async () => {
    const db = createDb(env.DB);
    await db.insert(shelters).values({
      id: "pending-1",
      slug: "refugio-pending",
      displayName: "Refugio Pendiente",
      accountEmail: "hola@pending.example",
      baseRegion: "Miranda",
      countryCode: "VE",
      createdAt: new Date("2026-01-01"),
    });
    await db.insert(shelterContactPoints).values({
      id: "contact-pending",
      shelterId: "pending-1",
      kind: "whatsapp",
      value: "+58 412 5550002",
      position: 0,
      createdAt: new Date("2026-01-01"),
    });
    await seedAnimal({ shelterId: "pending-1" });

    expect((await regenerate()).animalCount).toBe(0);
  });

  /**
   * Standing is the outcome off the *top* of an append-only log, so a shelter that was
   * verified and later revoked must fall out — and the log still holds the `Verified` entry
   * underneath, which is what makes this different from the test above.
   */
  it("withholds an animal whose shelter's latest entry is a revocation", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });
    expect((await regenerate()).animalCount).toBe(1);

    await decideShelter("shelter-1", "Revoked");

    expect((await regenerate()).animalCount).toBe(0);
  });

  it("withholds an animal whose shelter offers no contact point", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });
    await createDb(env.DB)
      .delete(shelterContactPoints)
      .where(eq(shelterContactPoints.shelterId, "shelter-1"));

    expect((await regenerate()).animalCount).toBe(0);
  });

  /**
   * *The fourth clause — `shelter.departedAt is null` — has no column to fail on until
   * Departure lands with issue #65, so it has no test of its own here: one written today
   * would be asserting `null === null`. `../src/lib/listing/store.ts` records where the field
   * enters when that ticket adds it.*
   *
   * A regeneration's unit is the act and never the animal, which is what keeps a bulk act
   * from being quadratic — three animals across two shelters is one index and one pointer.
   */
  it("writes one index for three animals across two shelters", async () => {
    await seedListableShelter("shelter-1", "Miranda");
    await seedListableShelter("shelter-2", "Aragua");
    await seedAnimal({ id: "a1", shelterId: "shelter-1" });
    await seedAnimal({ id: "a2", shelterId: "shelter-2" });
    await seedAnimal({ id: "a3", shelterId: "shelter-2" });

    const result = await regenerate();

    expect(result.animalCount).toBe(3);
    /** One index object and one pointer: a regeneration's unit is the act, not the animal. */
    const listed = await env.MEDIA.list({ prefix: INDEX_PREFIX });
    expect(listed.objects).toHaveLength(2);
  });

  it("leaves out a listed animal whose primary photograph is gone, and counts it", async () => {
    await seedListableShelter();
    const { sessionId } = await seedAnimal({ shelterId: "shelter-1" });
    await createDb(env.DB)
      .delete(uploadSessionPhotos)
      .where(eq(uploadSessionPhotos.sessionId, sessionId));

    const result = await regenerate();

    expect(result.animalCount).toBe(0);
    expect(result.withoutPhoto).toBe(1);
  });

  it("names the primary photo's card derivative, under d/", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });

    await regenerate();
    const { index } = await currentIndex();

    expect(index.animals[0]?.thumbnailKey).toMatch(/^d\/[0-9a-f]{64}\.webp$/);
  });
});

describe("the index object and its pointer", () => {
  it("stores the index gzipped, declared, and immutable for a year", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });

    const { key } = await regenerate();
    const object = await env.MEDIA.head(key);

    expect(object?.httpMetadata?.contentEncoding).toBe("gzip");
    expect(object?.httpMetadata?.cacheControl).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(object?.httpMetadata?.contentType).toBe("application/json");
  });

  it("marks the pointer no-store, because it is the one object that moves", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });
    await regenerate();

    const pointer = await env.MEDIA.head(INDEX_POINTER_KEY);

    expect(pointer?.httpMetadata?.cacheControl).toBe("no-store");
  });

  it("keys the index by its bytes, so a changed catalogue is a new key", async () => {
    await seedListableShelter();
    await seedAnimal({ id: "a1", shelterId: "shelter-1" });
    const first = await regenerate();

    await seedAnimal({ id: "a2", shelterId: "shelter-1", name: "Negrita" });
    const second = await regenerate();

    expect(second.key).not.toBe(first.key);
    expect(second.changed).toBe(true);
  });

  /**
   * ADR 0018's free nightly no-op, asserted rather than assumed: an unchanged catalogue
   * produces identical bytes, hence the same key, hence a `put` over the object that is
   * already there. `changed: false` is the ADR's own drift signal reading clean.
   */
  it("lands on the same key when nothing listed has changed", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });

    const first = await regenerate();
    const again = await regenerate(new Date("2026-09-08T23:00:00.000Z"));

    expect(again.key).toBe(first.key);
    expect(again.changed).toBe(false);
    expect(
      (await env.MEDIA.list({ prefix: INDEX_PREFIX })).objects,
    ).toHaveLength(2);
  });

  /**
   * The drift signal, from the other side: a nightly run landing on a key the pointer did
   * not already name means a publish-path write had been lost. Simulated by pointing the
   * pointer at a key nobody wrote, which is exactly the state a lost `put` leaves behind.
   */
  it("reports a changed key when a publish-path write had been lost", async () => {
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });
    await env.MEDIA.put(
      INDEX_POINTER_KEY,
      JSON.stringify({ key: "i/lost.json", generatedAt: NOW.toISOString() }),
    );

    expect((await regenerate()).changed).toBe(true);
  });

  it("regenerates from an empty catalogue rather than refusing to", async () => {
    const result = await regenerate();
    const { index } = await currentIndex();

    expect(result.animalCount).toBe(0);
    expect(index.animals).toEqual([]);
  });
});

describe("keeping the i/ prefix", () => {
  /**
   * These two anchor to the real clock rather than to {@link NOW}, and that is the point
   * rather than a convenience: the age test reads `uploaded`, which **R2 stamps itself**, so
   * the only way to exercise the grace is to move the clock the regenerator is *given* past
   * the one the bucket recorded. A fixed `NOW` would be compared against a real timestamp and
   * the test would pass or fail depending on the hour it ran at.
   */
  it("collects a superseded index once it is past its hour, and never the pointer", async () => {
    await seedListableShelter();
    await seedAnimal({ id: "a1", shelterId: "shelter-1" });
    const first = await regenerate(new Date());

    await seedAnimal({ id: "a2", shelterId: "shelter-1", name: "Negrita" });
    /** An hour and a second later, so the first index has aged out of its grace. */
    const later = new Date(Date.now() + SUPERSEDED_INDEX_GRACE_MS + 1_000);
    const second = await regenerate(later);

    expect(second.collected).toBe(1);
    const keys = (await env.MEDIA.list({ prefix: INDEX_PREFIX })).objects.map(
      (object) => object.key,
    );
    expect(keys).toContain(INDEX_POINTER_KEY);
    expect(keys).toContain(second.key);
    expect(keys).not.toContain(first.key);
  });

  it("leaves a just-superseded index alone, for a reader between its two fetches", async () => {
    await seedListableShelter();
    await seedAnimal({ id: "a1", shelterId: "shelter-1" });
    const first = await regenerate(new Date());

    await seedAnimal({ id: "a2", shelterId: "shelter-1", name: "Negrita" });
    const second = await regenerate(new Date(Date.now() + 60_000));

    expect(second.collected).toBe(0);
    const keys = (await env.MEDIA.list({ prefix: INDEX_PREFIX })).objects.map(
      (object) => object.key,
    );
    expect(keys).toContain(first.key);
  });

  /**
   * `d/` is reclamation's entire scope and the index is not opted into it, so a regeneration
   * must not touch a derivative — including one that no animal references, which is the
   * nightly sweep's business and not this writer's.
   */
  it("never touches an object outside its own prefix", async () => {
    await env.MEDIA.put("d/orphan.webp", "not an index");
    await seedListableShelter();
    await seedAnimal({ shelterId: "shelter-1" });

    await regenerate(new Date(NOW.getTime() + SUPERSEDED_INDEX_GRACE_MS + 1_000));

    expect(await env.MEDIA.head("d/orphan.webp")).not.toBeNull();
  });
});

/**
 * The trigger, exercised through the real routes rather than by calling the regenerator.
 *
 * ADR 0018's decision is not only "a regeneration is whole" but "**its unit is the act**", and
 * an act is a `POST`. A test that called `regenerateIndex()` directly would pass just as
 * happily on a publish path that never calls it — which is the whole failure mode: the animal
 * is written, the shelter is told it published, and no adopter can see it.
 */
describe("the acts that regenerate", () => {
  /** The emailed decision link's token, minted rather than read out of an inbox. */
  async function decisionToken(shelterId: string): Promise<string> {
    return await mintAdminLink(
      env,
      { kind: "decision", shelterId, admin: env.ADMIN_EMAIL },
      NOW,
    );
  }

  /** A signed-in, verified shelter holding staged photographs, ready to publish. */
  async function readyToPublish() {
    outbound.reset();
    const { shelterId, cookie } = await signIn();
    await verifyShelter(shelterId);
    const sessionId = await seedUploadSession(shelterId, 1);
    return { shelterId, cookie, sessionId };
  }

  const PUBLISH_FORM: Record<string, string> = {
    name: "Canela",
    species: "dog",
    sex: "Female",
    size: "Medium",
    estimatedBirthDate: "2025-01-01",
    ageEstimateBasis: "ShelterGuess",
    region: "Valencia",
    "goodWith.children": "Yes",
    "goodWith.dogs": "Yes",
    "goodWith.cats": "Unknown",
    description: "Cariñosa y tranquila. Camina bien con correa.",
    medicalNeeds: "",
    sterilisation: "Sterilised",
  };

  it("a publish writes the index, so the animal is visible in seconds", async () => {
    const { cookie, sessionId } = await readyToPublish();

    const response = await post(
      `/refugios/animales/nuevo?sesion=${sessionId}`,
      PUBLISH_FORM,
      { cookie },
    );
    expect(response.status).toBe(303);

    const { index } = await currentIndex();
    expect(index.animals.map((animal) => animal.name)).toEqual(["Canela"]);
  });

  /**
   * The direction ADR 0001 calls worse than no listing at all. The row says `Adopted` the
   * moment the edit commits, but an adopter reads the index — so if the edit did not
   * regenerate, the animal would stay on adopters' cards until somebody else happened to
   * publish something.
   */
  it("marking an animal adopted takes it off the index", async () => {
    const { cookie, sessionId } = await readyToPublish();
    const published = await post(
      `/refugios/animales/nuevo?sesion=${sessionId}`,
      PUBLISH_FORM,
      { cookie },
    );
    const animalId = /animales\/([^?]+)\?/.exec(
      published.headers.get("location")!,
    )![1]!;
    expect((await currentIndex()).index.animals).toHaveLength(1);

    const edited = await post(
      `/refugios/animales/${animalId}`,
      { ...PUBLISH_FORM, availability: "Adopted" },
      { cookie },
    );
    expect(edited.status).toBe(303);

    expect((await currentIndex()).index.animals).toEqual([]);
  });

  /**
   * One act, one regeneration, for a whole roster — the bulk case ADR 0018 is shaped around.
   * Verification is a clause of the listing rule, so verifying a shelter lists everything it
   * has published at once, and per-animal regeneration would have made that quadratic.
   */
  it("a verification lists the shelter's whole roster in one regeneration", async () => {
    await seedListableShelter("shelter-unverified");
    await env.DB.exec("DELETE FROM verifications");
    await seedAnimal({ id: "a1", shelterId: "shelter-unverified" });
    await seedAnimal({ id: "a2", shelterId: "shelter-unverified" });
    await regenerate();
    expect((await currentIndex()).index.animals).toEqual([]);

    const response = await post("/admin/decide", {
      t: await decisionToken("shelter-unverified"),
      outcome: "Verified",
      methods: ["instagram"],
      evidence: "instagram.com/refugio, active",
    });
    expect(response.status).toBe(303);

    const listed = await env.MEDIA.list({ prefix: INDEX_PREFIX });
    expect((await currentIndex()).index.animals.map((a) => a.id)).toEqual([
      "a1",
      "a2",
    ]);
    /** The pointer, the index the verification wrote, and the empty one it superseded. */
    expect(listed.objects.length).toBeLessThanOrEqual(3);
  });

  it("a revocation delists the same roster, in one regeneration", async () => {
    await seedListableShelter();
    await seedAnimal({ id: "a1", shelterId: "shelter-1" });
    await regenerate();
    expect((await currentIndex()).index.animals).toHaveLength(1);

    /**
     * Through the off-link endpoint with a hand-minted token, because that is the only way a
     * revocation can be written: ADR 0002 keeps it off every emailed link, so no other path
     * exists to test.
     */
    const token = await mintAdminLink(
      env,
      { kind: "revocation", shelterId: "shelter-1", admin: env.ADMIN_EMAIL },
      NOW,
    );
    const response = await post("/api/admin/revoke", {
      t: token,
      outcome: "Revoked",
      evidence: "the account was sold; the number answers as a different organisation",
    });
    expect(response.status).toBe(200);

    expect((await currentIndex()).index.animals).toEqual([]);
  });
});

describe("the order the browser is handed", () => {
  /**
   * The index is written in **id** order, because content-addressing needs deterministic
   * bytes; display order is the browser's, per ADR 0018. Both halves are asserted here
   * because they are easy to conflate and the failure of either is silent.
   */
  it("writes id order, leaving freshest-first to the browser", async () => {
    await seedListableShelter();
    await seedAnimal({
      id: "zebra",
      shelterId: "shelter-1",
      lastConfirmedAt: new Date("2026-09-07T00:00:00.000Z"),
    });
    await seedAnimal({
      id: "alpha",
      shelterId: "shelter-1",
      lastConfirmedAt: new Date("2026-05-01T00:00:00.000Z"),
    });

    await regenerate();
    const { index } = await currentIndex();

    expect(index.animals.map((animal) => animal.id)).toEqual([
      "alpha",
      "zebra",
    ]);
  });
});
