import { env, SELF } from "cloudflare:test";
import { animals, createDb, shelters } from "@pawster/db";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The `web/` end of the test seam: one request that never reaches Worker code, and one
 * that does and reads a real local D1 with the real migrations applied. Both go through
 * `SELF.fetch()`, which is the whole Worker — asset router included — rather than a
 * handler called directly.
 */

const get = (path: string) => SELF.fetch(`https://pawster.test${path}`);

async function seedAnimal() {
  const db = createDb(env.DB);
  await db.insert(shelters).values({
    id: "shelter-1",
    displayName: "Refugio Los Teques",
    accountEmail: "hola@refugio.example",
    countryCode: "VE",
    createdAt: new Date("2026-01-01"),
  });
  await db.insert(animals).values({
    id: "animal-1",
    shelterId: "shelter-1",
    name: "Canela",
    species: "dog",
    estimatedBirthDate: new Date("2025-01-01"),
    region: "Miranda",
    lastConfirmedAt: new Date("2026-08-30"),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM animals");
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
  it("reads a real row from a real local D1", async () => {
    await seedAnimal();

    const response = await get("/animales/animal-1");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="animal-name">Canela');
    expect(html).toContain('data-testid="shelter-name">Refugio Los Teques');
    expect(html).toContain('data-testid="region">Miranda');
  });

  it("derives the age band at read time rather than reading a stored one", async () => {
    await seedAnimal();

    const html = await (await get("/animales/animal-1")).text();

    // Born 2025-01-01; today is well past twelve months, so the dog has graduated out of
    // Puppy on its own, with nothing having written to the row (ADR 0004).
    expect(html).toContain('data-testid="age-band">Young');
    expect(html).not.toContain("Puppy");
  });

  it("404s for an animal that does not exist", async () => {
    const response = await get("/animales/nope");
    expect(response.status).toBe(404);
  });

  it("builds its Drizzle client per request, so a second request works too", async () => {
    await seedAnimal();

    expect((await get("/animales/animal-1")).status).toBe(200);
    expect((await get("/animales/animal-1")).status).toBe(200);
  });
});
