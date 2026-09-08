import { createDb, shelterContactPoints, shelters } from "@pawster/db";
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedAnimal } from "./support/animal.ts";
import { clearShelterTables, verifyShelter } from "./support/shelter.ts";

/**
 * The `web/` end of the test seam: one request that never reaches Worker code, and one
 * that does and reads a real local D1 with the real migrations applied. Both go through
 * `SELF.fetch()`, which is the whole Worker — asset router included — rather than a
 * handler called directly.
 */

const get = (path: string) => SELF.fetch(`https://pawster.test${path}`);

/**
 * A shelter and one of its animals. The animal's own shape lives in `support/animal.ts`,
 * because `shelter-profile.test.ts` seeds the same row and issue #55 made it wide enough that
 * two copies would drift.
 */
async function seedShelterWithAnimal(): Promise<void> {
  await createDb(env.DB).insert(shelters).values({
    id: "shelter-1",
    slug: "refugio-los-teques",
    displayName: "Refugio Los Teques",
    accountEmail: "hola@refugio.example",
    baseRegion: "Miranda",
    countryCode: "VE",
    createdAt: new Date("2026-01-01"),
  });
  /**
   * One contact point, because `isListed()` requires one: without it the animal would be
   * withheld for a second reason and the verification tests below could not tell which clause
   * they were observing.
   */
  await createDb(env.DB).insert(shelterContactPoints).values({
    id: "contact-1",
    shelterId: "shelter-1",
    kind: "whatsapp",
    value: "+58 412 5550001",
    position: 0,
    createdAt: new Date("2026-01-01"),
  });
  await seedAnimal({ shelterId: "shelter-1" });
}

/**
 * Through the shared helper rather than two deletes of its own. A shelter now owns contact
 * points and verification entries as well as animals, and this suite writes all three — a
 * local `DELETE FROM shelters` fails on the foreign keys, and the version that listed the
 * tables by hand would have to be updated by every ticket that adds one.
 */
beforeEach(clearShelterTables);

describe("the prerendered listing page", () => {
  it("exists as a static asset, which is what lets the asset router answer it", async () => {
    // The load-bearing assertion, and the one that actually fails if someone adds
    // `export const prerender = false` to `index.astro`: a prerendered page is written to
    // `dist/client/` at build time and lives in the Static Assets store, so the asset
    // router serves it *ahead of* the Worker and no invocation is billed (ADR 0007).
    //
    // Asking the `ASSETS` binding directly is what distinguishes the two worlds. Measured
    // both ways: prerendered, this returns 200 and the page; with `prerender = false` there
    // is no `dist/client/index.html` at all and it returns **404** — while `SELF.fetch("/")`
    // returns 200 either way, because the Worker renders it. That is precisely why a
    // `SELF` status check cannot see the regression and this can.
    const asset = await env.ASSETS.fetch("https://pawster.test/");

    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain(
      'data-testid="prerendered">Animales en adopción',
    );
  });

  it("is served from that asset rather than rendered per request", async () => {
    const [served, asset] = await Promise.all([
      get("/"),
      env.ASSETS.fetch("https://pawster.test/"),
    ]);

    expect(served.status).toBe(200);
    // Byte-identical to the file on disk: nothing was rendered, interpolated or read from
    // D1 between the build and this response.
    expect(await served.text()).toBe(await asset.text());
  });
});

describe("the server-rendered animal detail page", () => {
  /**
   * ## What is asserted here, and what moved
   *
   * This file is the **routing seam**: one request that never reaches Worker code and one that
   * does. So what stays here is the shape of the route — that the address resolves, that an
   * unverified shelter's animal has no public existence, and that the Drizzle client is built
   * per request. Everything the page *says* — the consequence sentence, the age's basis, the
   * contact hand-off, the social preview, the archive wordings — is issue #57's and lives in
   * `animal-page.test.ts`, so that a change to the copy fails in the suite about the copy.
   *
   * The address is `/a/<id>/<name>` and only the id resolves (issue #57, ADR 0020); the page
   * that used to answer at `/animales/<id>` is gone rather than redirected, because Pawster has
   * never been deployed and that URL is one nobody holds.
   */
  it("404s an animal whose shelter is not verified", async () => {
    await seedShelterWithAnimal();

    const response = await get("/a/animal-1/canela");

    expect(response.status).toBe(404);
    // A 404 and not an archive page: an animal of an unverified shelter was never publicly
    // reachable, so there is no promise to an adopter to keep, and a page saying anything at
    // all would leak both that the id is real and that the shelter is not yet verified.
    expect(await response.text()).not.toContain("Canela");
  });

  it("renders a verified shelter's animal, joining its display name", async () => {
    await seedShelterWithAnimal();
    await verifyShelter("shelter-1", "Refugio Los Teques");

    const response = await get("/a/animal-1/canela");
    const html = await response.text();

    /**
     * The one thing that changed is a row in an append-only log — nothing was written to the
     * animal, and no `listed` column exists to write. So this is `isListed()` opening, observed
     * from outside, and it is the assertion that would catch the gate being wired to something
     * other than the verification log.
     */
    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="animal-name">Canela');
    expect(html).toContain('data-testid="shelter-name">Refugio Los Teques');
    // The region rides on the meta line and has no row of its own — the facts table drops what
    // the heading already says.
    expect(html).toContain('data-testid="animal-meta">Perra joven · Mediana · Miranda');
  });

  it("404s for an animal that does not exist", async () => {
    const response = await get("/a/nope/whatever");
    expect(response.status).toBe(404);
  });

  it("builds its Drizzle client per request, so a second request works too", async () => {
    await seedShelterWithAnimal();

    await verifyShelter("shelter-1", "Refugio Los Teques");

    // A module-scope client would fail the second request with a 500 — the regression this
    // exists to catch — so both are asserted, not just the first.
    expect((await get("/a/animal-1/canela")).status).toBe(200);
    expect((await get("/a/animal-1/canela")).status).toBe(200);
  });
});
