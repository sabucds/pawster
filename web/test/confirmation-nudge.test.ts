import { CONFIRM_PATH, INDEX_POINTER_KEY, confirmationUrl, parseIndex } from "@pawster/domain";
import type { IndexPointer } from "@pawster/domain";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { seedAnimal } from "./support/animal.ts";
import { get, post } from "./support/http.ts";
import { REGISTRATION, clearShelterTables, signIn, verifyShelter } from "./support/shelter.ts";

/**
 * Issue #60: what a shelter can do from the link in a Confirmation Nudge, with no session.
 *
 * ADR 0008 draws the line this suite checks: the link confirms and changes an animal's state,
 * and nothing else. Everything goes through the real routes, because "a GET mutates nothing" and
 * "the link grants no session" are statements about HTTP responses.
 */

const DAY = 86_400_000;
const stale = () => new Date(Date.now() - 45 * DAY);

interface AnimalRow {
  id: string;
  availability: string;
  last_confirmed_at: number;
  last_confirmed_via: string;
  upload_session_id: string;
}

async function animalRow(id: string): Promise<AnimalRow> {
  const row = await env.DB.prepare("SELECT * FROM animals WHERE id = ?").bind(id).first<AnimalRow>();
  return row!;
}

/** A verified shelter that was nudged once, and the path of the link that nudge carried. */
async function nudged(): Promise<{ shelterId: string; cookie: string; link: string }> {
  const { shelterId, cookie } = await signIn();
  await verifyShelter(shelterId);
  await env.DB.prepare("UPDATE shelters SET nudge_version = 1, nudged_at = ? WHERE id = ?")
    .bind(Date.now(), shelterId)
    .run();
  const url = await confirmationUrl(env, {
    shelterId,
    version: 1,
    accountEmail: REGISTRATION.accountEmail,
  });
  return { shelterId, cookie, link: url.slice(url.indexOf(CONFIRM_PATH)) };
}

async function listedIds(): Promise<string[]> {
  const pointerObject = await env.MEDIA.get(INDEX_POINTER_KEY);
  const pointer = JSON.parse(await pointerObject!.text()) as IndexPointer;
  const object = await env.MEDIA.get(pointer.key);
  const text = await new Response(object!.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return parseIndex(text).animals.map((animal) => animal.id).sort();
}

beforeEach(async () => {
  await clearShelterTables();
  outbound.reset();
});

describe("the confirmation link", () => {
  it("shows the shelter's animals on a GET and changes nothing", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId, name: "Canela", lastConfirmedAt: stale() });
    const before = await animalRow("canela");

    const response = await get(link);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain("Canela");
    expect(html).not.toContain(REGISTRATION.accountEmail);
    expect(await animalRow("canela")).toEqual(before);
  });

  it("confirms every available animal without a session, and records it came from a link", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId, name: "Canela", lastConfirmedAt: stale() });
    await seedAnimal({ id: "toby", shelterId, name: "Toby", lastConfirmedAt: stale() });
    const started = Date.now();

    const response = await post(link, { accion: "confirmar-todos" });

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toBeNull();
    for (const id of ["canela", "toby"]) {
      const row = await animalRow(id);
      expect(row.last_confirmed_at).toBeGreaterThanOrEqual(started);
      expect(row.last_confirmed_via).toBe("link");
    }
  });

  it("marks one animal adopted, takes it off the listing, and relists it under the same id", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId, name: "Canela", lastConfirmedAt: stale() });
    await seedAnimal({ id: "toby", shelterId, name: "Toby", lastConfirmedAt: stale() });
    const session = (await animalRow("canela")).upload_session_id;

    expect((await post(link, { accion: "estado", animal: "canela", estado: "Adopted" })).status).toBe(303);
    expect((await animalRow("canela")).availability).toBe("Adopted");
    expect((await animalRow("canela")).last_confirmed_via).toBe("link");
    expect(await listedIds()).toEqual(["toby"]);

    await post(link, { accion: "estado", animal: "canela", estado: "NoLongerAvailable" });
    expect((await animalRow("canela")).availability).toBe("NoLongerAvailable");

    await post(link, { accion: "estado", animal: "canela", estado: "Available" });
    const relisted = await animalRow("canela");
    expect(relisted.availability).toBe("Available");
    expect(relisted.upload_session_id).toBe(session);
    expect(await listedIds()).toEqual(["canela", "toby"]);
  });

  it("carries a state change to the whole bonded group", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "a", shelterId, bondedGroupId: "g", lastConfirmedAt: stale() });
    await seedAnimal({ id: "b", shelterId, bondedGroupId: "g", lastConfirmedAt: stale() });

    await post(link, { accion: "estado", animal: "a", estado: "Adopted" });

    expect((await animalRow("b")).availability).toBe("Adopted");
  });

  it("cannot touch another shelter's animal", async () => {
    const { link } = await nudged();
    outbound.reset();
    const other = await signIn("otro@refugio.example");
    await seedAnimal({ id: "ajena", shelterId: other.shelterId });

    await post(link, { accion: "estado", animal: "ajena", estado: "Adopted" });

    expect((await animalRow("ajena")).availability).toBe("Available");
  });

  it("offers nothing but confirming and state, and links out to sign-in", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId });

    const html = await (await get(link)).text();

    expect(html).toContain('href="/refugios/entrar"');
    const fields = [...html.matchAll(/<(?:input|select|textarea)[^>]*\sname="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(fields)).toEqual(new Set(["accion", "animal", "estado"]));
    expect(html).not.toMatch(/<form[^>]*action=/);
    expect(html).not.toContain('type="file"');
  });

  it("refuses anything else posted to it", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId });

    const response = await post(link, { accion: "estado", animal: "canela", description: "x" });

    expect(response.status).toBe(400);
  });

  it("stops working once a newer nudge supersedes it", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId, lastConfirmedAt: stale() });
    const before = await animalRow("canela");
    await env.DB.prepare("UPDATE shelters SET nudge_version = 2 WHERE id = ?").bind(shelterId).run();

    expect((await get(link)).status).toBe(410);
    expect((await post(link, { accion: "confirmar-todos" })).status).toBe(410);
    expect(await animalRow("canela")).toEqual(before);
  });

  it("stops working once the shelter has asked to leave", async () => {
    const { shelterId, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId, lastConfirmedAt: stale() });
    const before = await animalRow("canela");
    await env.DB.prepare("UPDATE shelters SET departed_at = ? WHERE id = ?")
      .bind(Date.now(), shelterId)
      .run();

    expect((await get(link)).status).toBe(410);
    expect((await post(link, { accion: "confirmar-todos" })).status).toBe(410);
    expect(await animalRow("canela")).toEqual(before);
  });

  it("stops working once the account email changes", async () => {
    const { shelterId, cookie, link } = await nudged();
    await seedAnimal({ id: "canela", shelterId, lastConfirmedAt: stale() });
    const before = await animalRow("canela");

    const change = await post("/refugios/correo", { accountEmail: "nuevo@refugio.example", accountEmailAgain: "nuevo@refugio.example" }, { cookie });
    expect(change.status).toBe(303);

    expect((await post(link, { accion: "confirmar-todos" })).status).toBe(410);
    expect(await animalRow("canela")).toEqual(before);
  });
});

describe("the in-session 'still available' click", () => {
  it("confirms the animal and its group, records a session, and changes nothing else", async () => {
    const { shelterId, cookie } = await signIn();
    await verifyShelter(shelterId);
    await seedAnimal({ id: "a", shelterId, name: "Canela", bondedGroupId: "g", lastConfirmedAt: stale() });
    await seedAnimal({ id: "b", shelterId, name: "Toby", bondedGroupId: "g", lastConfirmedAt: stale() });
    await env.DB.exec("UPDATE animals SET last_confirmed_via = 'link'");
    const before = await animalRow("a");
    const started = Date.now();

    const response = await post("/refugios/animales/a", { accion: "confirmar" }, { cookie });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^\/refugios\/animales\/a\?confirmado/);
    for (const id of ["a", "b"]) {
      const row = await animalRow(id);
      expect(row.last_confirmed_at).toBeGreaterThanOrEqual(started);
      expect(row.last_confirmed_via).toBe("session");
    }
    const after = await animalRow("a");
    expect({ ...after, last_confirmed_at: 0, last_confirmed_via: "" }).toEqual({
      ...before,
      last_confirmed_at: 0,
      last_confirmed_via: "",
    });
  });

  it("is offered on the animal's page", async () => {
    const { shelterId, cookie } = await signIn();
    await seedAnimal({ id: "a", shelterId });

    const html = await (await get("/refugios/animales/a", cookie)).text();

    expect(html).toContain('name="accion" value="confirmar"');
  });
});
