import { INDEX_POINTER_KEY, parseIndex } from "@pawster/domain";
import type { IndexPointer } from "@pawster/domain";
import { createDb } from "@pawster/db";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { regenerateIndex } from "../src/lib/listing/regenerate.ts";
import { seedAnimal } from "./support/animal.ts";
import { get, post } from "./support/http.ts";
import { REGISTRATION, ageMailLedger, clearShelterTables, signIn, verifyShelter } from "./support/shelter.ts";

/**
 * Departure (issue #65, ADR 0015), through the Worker's front door against a real D1 and R2.
 *
 * What is asserted is what a shelter and an adopter can observe: the page's answer, the filter
 * index in the bucket, and the public animal page. The `departed_at` column is read directly
 * only where the ticket names it as the record of the act.
 */

const PATH = "/refugios/dejar-pawster";
const DAY = 86_400_000;

async function departedAt(shelterId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT departed_at FROM shelters WHERE id = ?")
    .bind(shelterId)
    .first<{ departed_at: number | null }>();
  return row!.departed_at;
}

async function listedIds(): Promise<string[]> {
  const pointerObject = await env.MEDIA.get(INDEX_POINTER_KEY);
  if (!pointerObject) return [];
  const pointer = JSON.parse(await pointerObject.text()) as IndexPointer;
  const object = await env.MEDIA.get(pointer.key);
  const text = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return parseIndex(text).animals.map((animal) => animal.id).sort();
}

/** The index as a listing act before departure would have left it. */
async function regenerate(): Promise<void> {
  await regenerateIndex({ db: createDb(env.DB), media: env.MEDIA, now: new Date() });
}

async function verificationCount(shelterId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM verifications WHERE shelter_id = ?")
    .bind(shelterId)
    .first<{ n: number }>();
  return row!.n;
}

async function depart(cookie: string, displayName = REGISTRATION.displayName) {
  return await post(PATH, { displayName }, { cookie });
}

beforeEach(async () => {
  await clearShelterTables();
  outbound.reset();
});

describe("requesting departure", () => {
  it("needs a session", async () => {
    const response = await post(PATH, { displayName: REGISTRATION.displayName });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/entrar");
  });

  it("states what is erased at thirty days and what is kept", async () => {
    const { cookie } = await signIn();

    const html = await (await get(PATH, cookie)).text();

    const destroyed = html.slice(html.indexOf('data-testid="destroyed"'), html.indexOf('data-testid="kept"'));
    expect(destroyed).toContain("30 días");
    expect(destroyed).toContain("formas de contacto");
    expect(destroyed).toContain("correo del refugio");
    expect(destroyed).toContain("sesiones");
    const kept = html.slice(html.indexOf('data-testid="kept"'));
    expect(kept).toContain("nombre del refugio");
    expect(kept).toContain("páginas de archivo");
    expect(kept).toContain("registro de verificación");
  });

  it("refuses a name that is not the shelter's display name, and departs nothing", async () => {
    const { shelterId, cookie } = await signIn();

    const response = await depart(cookie, "Refugio Los Teque");

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('data-testid="errors"');
    expect(await departedAt(shelterId)).toBeNull();
  });

  it("departs on the exact display name, and writes no verification entry", async () => {
    const { shelterId, cookie } = await signIn();
    await verifyShelter(shelterId);
    const entriesBefore = await verificationCount(shelterId);

    const response = await depart(cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/panel");
    expect(await departedAt(shelterId)).not.toBeNull();
    expect(await verificationCount(shelterId)).toBe(entriesBefore);
  });
});

describe("what departure does to the listing", () => {
  it("delists a roster of dozens in one act and keeps every animal's availability", async () => {
    const { shelterId, cookie } = await signIn();
    await verifyShelter(shelterId);
    const ids = Array.from({ length: 40 }, (_, i) => `animal-${String(i).padStart(2, "0")}`);
    for (const id of ids) await seedAnimal({ id, shelterId });
    await regenerate();
    expect(await listedIds()).toEqual(ids);

    const response = await depart(cookie);

    expect(response.status).toBe(303);
    expect(await listedIds()).toEqual([]);
    const availabilities = await env.DB.prepare(
      "SELECT DISTINCT availability FROM animals WHERE shelter_id = ?",
    )
      .bind(shelterId)
      .all<{ availability: string }>();
    expect(availabilities.results.map((row) => row.availability)).toEqual(["Available"]);
  });
});

describe("what an adopter sees after departure", () => {
  it("is an archive page in fixed platform words, with no farewell of the shelter's", async () => {
    const { shelterId, cookie } = await signIn();
    await verifyShelter(shelterId);
    await seedAnimal({ id: "canela", shelterId, name: "Canela", sex: "Female" });

    await post(PATH, { displayName: REGISTRATION.displayName, farewell: "Gracias por todo, amigos" }, { cookie });

    const response = await get("/a/canela/canela");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("El refugio que la publicó ya no está en Pawster");
    expect(html).toContain(REGISTRATION.displayName);
    expect(html).not.toContain("Gracias por todo");
  });
});

describe("the thirty days after departure", () => {
  it("still lets the shelter sign in and reach its panel", async () => {
    const { shelterId, cookie } = await signIn();
    await depart(cookie);
    outbound.reset();
    await ageMailLedger(10 * 60_000);

    const again = await signIn();
    expect(again.shelterId).toBe(shelterId);
    expect((await get("/refugios/panel", again.cookie)).status).toBe(200);
  });

  it("cancels in one click, relisting the animals with contact points and email untouched", async () => {
    const { shelterId, cookie } = await signIn();
    await verifyShelter(shelterId);
    await seedAnimal({ id: "canela", shelterId });
    await depart(cookie);
    expect(await listedIds()).toEqual([]);

    const panel = await (await get("/refugios/panel", cookie)).text();
    expect(panel).toContain('data-testid="departed"');

    const response = await post(PATH, { intent: "cancel" }, { cookie });

    expect(response.status).toBe(303);
    expect(await departedAt(shelterId)).toBeNull();
    expect(await listedIds()).toEqual(["canela"]);
    const panelAfter = await (await get("/refugios/panel", cookie)).text();
    expect(panelAfter).toContain(REGISTRATION.accountEmail);
    expect(panelAfter).not.toContain('data-testid="departed"');
    const contacts = await env.DB.prepare("SELECT count(*) AS n FROM shelter_contact_points WHERE shelter_id = ?")
      .bind(shelterId)
      .first<{ n: number }>();
    expect(contacts!.n).toBe(1);
  });

  it("refuses to cancel once the thirty days have passed", async () => {
    const { shelterId, cookie } = await signIn();
    await env.DB.prepare("UPDATE shelters SET departed_at = ? WHERE id = ?")
      .bind(Date.now() - 31 * DAY, shelterId)
      .run();

    const response = await post(PATH, { intent: "cancel" }, { cookie });

    expect(response.status).toBe(409);
    expect(await departedAt(shelterId)).not.toBeNull();
  });
});

describe("the privacy notice", () => {
  it("carries the two shelter rows: erased at thirty days, and kept with the reason", async () => {
    const html = await (await get("/privacidad")).text();
    const rows = html.match(/<tr data-testid="retention-row"[\s\S]*?<\/tr>/g) ?? [];

    const erased = rows.find((row) => row.includes("formas de contacto"));
    expect(erased).toContain("correo del refugio");
    expect(erased).toContain("30 días");
    expect(erased).toContain('data-enforced="true"');

    const kept = rows.find((row) => row.includes("páginas de archivo"));
    expect(kept).toContain("registro de verificación");
    expect(kept).toContain("Para siempre");
    expect(kept).toContain("promesa");
    expect(kept).toContain("nuestras propias decisiones");
  });
});
