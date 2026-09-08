import { createDb, shelters } from "@pawster/db";
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAnimalTables, seedAnimal } from "./support/animal.ts";

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
  await seedAnimal({ shelterId: "shelter-1" });
}

beforeEach(async () => {
  await clearAnimalTables();
  await env.DB.exec("DELETE FROM shelters");
});

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
   * ## Why nothing here renders an animal any more
   *
   * The page is gated on `domain/`'s `isListed()`, whose four clauses include the shelter being
   * verified — and `readShelterFacts()` returns `latestVerificationOutcome: null` for every
   * shelter, because ADR 0003 makes pending the *absence* of a log entry and issue #53 is what
   * adds the log. So no animal on the platform is publicly reachable yet, and that is issue
   * #55's last acceptance criterion holding rather than a regression.
   *
   * The render coverage this block used to carry — the row read from a real D1, the age band
   * derived at read time — moved to `animals.test.ts`, against the shelter's own authenticated
   * page. **When #53 lands, a verified shelter's animal belongs back here**, asserting the 200
   * and the joined display name.
   */
  it("404s an animal whose shelter is not verified", async () => {
    await seedShelterWithAnimal();

    const response = await get("/animales/animal-1");

    expect(response.status).toBe(404);
    // A 404 and not a "hidden" page: an unlisted animal has no public existence to describe,
    // and a page saying otherwise would leak both that the id is real and that the shelter is
    // not yet verified.
    expect(await response.text()).not.toContain("Canela");
  });

  it("404s for an animal that does not exist", async () => {
    const response = await get("/animales/nope");
    expect(response.status).toBe(404);
  });

  it("builds its Drizzle client per request, so a second request works too", async () => {
    await seedShelterWithAnimal();

    /**
     * Both requests reach the Worker, build a client and query D1 — the 404 comes from the
     * listing gate, *after* two reads. A module-scope client would fail the second request with
     * a 500 rather than a 404, which is the regression this test exists to catch.
     */
    expect((await get("/animales/animal-1")).status).toBe(404);
    expect((await get("/animales/animal-1")).status).toBe(404);
  });
});
