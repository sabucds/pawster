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
    listed: true,
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM animals");
  await env.DB.exec("DELETE FROM shelters");
});

describe("the prerendered listing page", () => {
  it("is served without invoking Worker code", async () => {
    const response = await get("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      'data-testid="prerendered">Animales en adopción',
    );

    // How we know Worker code did not run: `/` is prerendered, so Astro's server bundle
    // carries no route for it, and `@astrojs/cloudflare`'s entrypoint never touches the
    // `ASSETS` binding — grep it. If the request had reached the Worker there would be
    // nothing there to answer it. The asset router answered ahead of the Worker, which is
    // what ADR 0007 is buying: no invocation, no CPU, no count against the daily cap.
  });

  it("costs no D1 query, so an empty database changes nothing", async () => {
    await env.DB.exec("DELETE FROM animals");
    expect((await get("/")).status).toBe(200);
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
