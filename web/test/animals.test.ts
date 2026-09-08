import { animals, createDb } from "@pawster/db";
import { MAX_URGENT_PER_SHELTER, UPLOAD_SESSION_TTL_MS } from "@pawster/domain";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { seedUploadSession } from "./support/animal.ts";
import { get, post } from "./support/http.ts";
import {
  clearShelterTables,
  decideShelter,
  signIn,
} from "./support/shelter.ts";

/**
 * Publishing an animal and editing one, through the Worker's own front door.
 *
 * Every request goes through `SELF.fetch()` against a real local D1 with the real migrations
 * applied, which is what makes the two CHECK constraints and the unique index on
 * `upload_session_id` part of what is under test rather than schema decoration.
 *
 * ## What is tested here and what is tested in `domain/`
 *
 * `domain/src/animal.test.ts` owns the rules as arithmetic: the one-to-six photo count at each
 * edge, the size pairing in both directions, the urgency cap. This file owns what only a request
 * can show — that the rule is actually *reached* by the route, that a refusal renders as a
 * sentence beside the right control, and that a refused publish leaves **no row of any kind**.
 * Duplicating the edges here would be slower and would not add a fact.
 */

/** A complete, publishable dog. Each case below varies exactly one field of it. */
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

/** The edit form is the publish form plus the animal's situation. */
const EDIT_FORM: Record<string, string> = {
  ...PUBLISH_FORM,
  availability: "Available",
};

beforeEach(clearShelterTables);

/**
 * A registered, signed-in shelter, with the mail interceptor cleared first.
 *
 * `emailedCode()` asserts there is exactly one code email to read, so a test that signs in twice
 * — a second shelter, to prove a stranger gets a 404 — has to reset the log between them. Every
 * sign-in here goes through this rather than through `signIn()` directly, so no test has to
 * remember which of the two it is.
 */
async function freshShelter(accountEmail?: string) {
  outbound.reset();
  return accountEmail === undefined ? await signIn() : await signIn(accountEmail);
}

/** Sign in, stage some photographs, and come back holding what publishing needs. */
async function readyToPublish(photoCount = 3) {
  const { shelterId, cookie } = await freshShelter();
  const sessionId = await seedUploadSession(shelterId, photoCount);
  return { shelterId, cookie, sessionId, path: `/refugios/animales/nuevo?sesion=${sessionId}` };
}

async function storedAnimals(shelterId: string) {
  return await createDb(env.DB)
    .select()
    .from(animals)
    .where(eq(animals.shelterId, shelterId));
}

/** The id out of the `Location` a successful publish redirects to. */
function publishedId(response: Response): string {
  const location = response.headers.get("location");
  expect(location, "a successful publish should redirect").not.toBeNull();
  const match = /^\/refugios\/animales\/([^?]+)\?publicado$/.exec(location!);
  expect(match, `unexpected location: ${location}`).not.toBeNull();
  return match![1]!;
}

describe("reaching the publishing form", () => {
  it("turns away a request with no session", async () => {
    const response = await get("/refugios/animales/nuevo?sesion=whatever");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/entrar");
  });

  it("404s without an upload session, because the photos come first", async () => {
    const { cookie } = await freshShelter();
    // ADR 0012's ordering, as a URL: there is no way to render this form without having
    // uploaded, which is what makes the photo count an invariant of the insert.
    expect((await get("/refugios/animales/nuevo", cookie)).status).toBe(404);
  });

  it("404s on another shelter's session rather than 403", async () => {
    const other = await freshShelter("otro@refugio.example");
    const sessionId = await seedUploadSession(other.shelterId, 2, "session-other");

    const mine = await freshShelter("mio@refugio.example");
    const response = await get(
      `/refugios/animales/nuevo?sesion=${sessionId}`,
      mine.cookie,
    );

    // Telling a stranger that an id exists is itself an answer.
    expect(response.status).toBe(404);
  });

  it("404s a session older than the upload window", async () => {
    const { shelterId, cookie } = await freshShelter();
    /**
     * A day-old session with no animal is abandoned, and the reclamation sweep (ADR 0016, issue
     * #66) will delete its derivatives. Publishing from it would mint an animal whose
     * photographs are already scheduled for deletion, leaving nothing for the primary photo to
     * be — so the publish path refuses it, the same window the upload path refuses additions on.
     */
    const stale = new Date(Date.now() - UPLOAD_SESSION_TTL_MS - 1000);
    const sessionId = await seedUploadSession(shelterId, 2, "session-stale", stale);

    const response = await get(
      `/refugios/animales/nuevo?sesion=${sessionId}`,
      cookie,
    );

    expect(response.status).toBe(404);
  });

  it("says how many photos are ready and which one is primary", async () => {
    const { cookie, path } = await readyToPublish(3);
    const html = await (await get(path, cookie)).text();

    expect(html).toContain("Tienes 3 fotos listas.");
    expect(html).toContain("La primera es la principal.");
  });

  it("says the size is an adult prediction, and that not-known costs no reach", async () => {
    const { cookie, path } = await readyToPublish();
    const html = await (await get(path, cookie)).text();

    // Both are acceptance criteria of issue #55 rather than page furniture: a shelter that
    // read the size control as "how big is it now" would file every puppy as small, and one
    // that suspected "no se sabe" cost it reach would answer Yes to everything.
    expect(html).toContain("no el de ahora");
    expect(html).toContain("no le quita alcance");
  });

  it("warns that nothing is public until the shelter is verified", async () => {
    const { cookie, path } = await readyToPublish();
    const html = await (await get(path, cookie)).text();
    expect(html).toContain("no aparece en el sitio público");
  });
});

describe("publishing an animal", () => {
  it("writes one complete animal and redirects to its page", async () => {
    const { shelterId, cookie, sessionId, path } = await readyToPublish(3);

    const response = await post(path, PUBLISH_FORM, { cookie });
    expect(response.status).toBe(303);

    const [row] = await storedAnimals(shelterId);
    expect(row).toBeDefined();
    expect(row!.id).toBe(publishedId(response));
    expect(row!.name).toBe("Canela");
    expect(row!.species).toBe("dog");
    expect(row!.size).toBe("Medium");
    expect(row!.sterilisation).toBe("Sterilised");
    // The animal names the session it was assembled from, never the other way round.
    expect(row!.uploadSessionId).toBe(sessionId);
    // Publishing an animal *is* making it available; the form offers no other choice.
    expect(row!.availability).toBe("Available");
    // Both clocks start together at publication and diverge from the first edit onwards.
    expect(row!.matchableSince.getTime()).toBe(row!.lastConfirmedAt.getTime());
  });

  it("stores no ageBand, because the band is derived", async () => {
    const { shelterId, cookie, path } = await readyToPublish();
    await post(path, PUBLISH_FORM, { cookie });

    const [row] = await storedAnimals(shelterId);
    // ADR 0004: the band comes from `domain/` at read time so the animal graduates on its own.
    expect(row).not.toHaveProperty("ageBand");
    expect(Object.keys(row!)).not.toContain("ageBand");
  });

  it("gives the animal its own region, which need not be the shelter's", async () => {
    const { shelterId, cookie, path } = await readyToPublish();
    // The shelter registered in Miranda; this animal is fostered in Valencia.
    await post(path, { ...PUBLISH_FORM, region: "Valencia" }, { cookie });

    const [row] = await storedAnimals(shelterId);
    expect(row!.region).toBe("Valencia");
  });

  it("refuses a session with no photos, and writes nothing", async () => {
    const { shelterId, cookie, path } = await readyToPublish(0);

    const response = await post(path, PUBLISH_FORM, { cookie });

    // 200 and the form again, not a redirect: the refusal is the page.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sube al menos 1 foto");
    // "A partially completed upload session produces no animal row of any kind."
    expect(await storedAnimals(shelterId)).toHaveLength(0);
  });

  it("refuses a dog with no size and a cat carrying one", async () => {
    const bothDirections = [
      { fields: { species: "dog", size: "" }, says: "Se pregunta solo para perros" },
      { fields: { species: "cat", size: "Large" }, says: "El tamaño es solo para perros" },
    ];

    for (const { fields, says } of bothDirections) {
      await clearShelterTables();
      const { shelterId, cookie, path } = await readyToPublish();

      const response = await post(path, { ...PUBLISH_FORM, ...fields }, { cookie });

      expect(await response.text(), JSON.stringify(fields)).toContain(says);
      expect(await storedAnimals(shelterId)).toHaveLength(0);
    }
  });

  it("refuses a value outside a closed vocabulary", async () => {
    const { shelterId, cookie, path } = await readyToPublish();

    /**
     * `Other` is the value that matters, and it cannot arrive from the form — the radios only
     * offer `dog` and `cat`. It arrives from a hand-made request, and the cost of letting it
     * through is not a validation message: a shelter-invented species matches no subscription,
     * so it silently costs the shelter the reach it was publishing for.
     */
    const response = await post(path, { ...PUBLISH_FORM, species: "Other" }, { cookie });

    expect(await response.text()).toContain("Escoge si es perro o gato");
    expect(await storedAnimals(shelterId)).toHaveLength(0);
  });

  it("reports every problem at once rather than the first", async () => {
    const { cookie, path } = await readyToPublish();

    const html = await (
      await post(
        path,
        { ...PUBLISH_FORM, name: "", description: "", region: "" },
        { cookie },
      )
    ).text();

    // ADR 0007 assumes a metered connection; one error per submission would make a shelter
    // with three mistakes post four times.
    expect(html).toContain("Revisa lo siguiente:");
    expect(html).toContain("Escribe el nombre del animal.");
    expect(html).toContain("Escoge dónde está el animal.");
  });

  it("refuses a second publish from the same photos instead of crashing", async () => {
    const { shelterId, cookie, path } = await readyToPublish();

    const first = await post(path, PUBLISH_FORM, { cookie });
    expect(first.status).toBe(303);

    /**
     * A double-click, or a back-and-resubmit. The unique index on `upload_session_id` is the
     * invariant and it stays; without this pre-check it surfaces as a raw D1 `UNIQUE` violation,
     * which is a 500 where the honest answer is a sentence and a link to the animal.
     */
    const second = await post(path, PUBLISH_FORM, { cookie });

    expect(second.status).toBe(200);
    const html = await second.text();
    expect(html).toContain("Estas fotos ya se publicaron");
    // And exactly one animal exists, not two and not zero.
    expect(await storedAnimals(shelterId)).toHaveLength(1);
  });

  it("sends a shelter revisiting a used publish link to its animal", async () => {
    const { cookie, path } = await readyToPublish();
    const animalId = publishedId(await post(path, PUBLISH_FORM, { cookie }));

    const response = await get(path, cookie);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `/refugios/animales/${animalId}`,
    );
  });

  it("comes back filled in with what the shelter typed", async () => {
    const { cookie, path } = await readyToPublish();

    const html = await (
      await post(path, { ...PUBLISH_FORM, name: "", description: "Muy dulce" }, { cookie })
    ).text();

    // A refused form that reset itself would cost the shelter everything it had typed.
    expect(html).toContain("Muy dulce");
  });
});

describe("the urgency mark", () => {
  /** Publish one animal, optionally urgent, and return its id. */
  async function publishOne(
    shelterId: string,
    cookie: string,
    index: number,
    fields: Record<string, string> = {},
  ): Promise<Response> {
    const sessionId = await seedUploadSession(shelterId, 2, `session-${index}`);
    return await post(
      `/refugios/animales/nuevo?sesion=${sessionId}`,
      { ...PUBLISH_FORM, name: `Animal ${index}`, ...fields },
      { cookie },
    );
  }

  it("refuses a mark with nothing written in it", async () => {
    const { shelterId, cookie, path } = await readyToPublish();

    const response = await post(
      path,
      { ...PUBLISH_FORM, urgent: "si", urgentReason: "" },
      { cookie },
    );

    expect(await response.text()).toContain("Escribe por qué es urgente");
    expect(await storedAnimals(shelterId)).toHaveLength(0);
  });

  it("stores the reason, and the reason is the mark", async () => {
    const { shelterId, cookie, path } = await readyToPublish();

    await post(
      path,
      { ...PUBLISH_FORM, urgent: "si", urgentReason: "Necesita tratamiento ya" },
      { cookie },
    );

    const [row] = await storedAnimals(shelterId);
    expect(row!.urgentReason).toBe("Necesita tratamiento ya");
    // There is no `is_urgent` column that could disagree with it.
    expect(Object.keys(row!)).not.toContain("isUrgent");
  });

  it(`refuses a mark past ${MAX_URGENT_PER_SHELTER} concurrent`, async () => {
    const { shelterId, cookie } = await freshShelter();

    for (let index = 0; index < MAX_URGENT_PER_SHELTER; index++) {
      const response = await publishOne(shelterId, cookie, index, {
        urgent: "si",
        urgentReason: `Motivo ${index}`,
      });
      expect(response.status, `animal ${index} should publish`).toBe(303);
    }

    const fourth = await publishOne(shelterId, cookie, MAX_URGENT_PER_SHELTER, {
      urgent: "si",
      urgentReason: "Uno más",
    });

    expect(fourth.status).toBe(200);
    expect(await fourth.text()).toContain("animales marcados como urgentes");
    // The three that fit are still there; only the fourth was refused.
    expect(await storedAnimals(shelterId)).toHaveLength(MAX_URGENT_PER_SHELTER);
  });

  it("lets an unmarked animal be published once the cap is full", async () => {
    const { shelterId, cookie } = await freshShelter();

    for (let index = 0; index < MAX_URGENT_PER_SHELTER; index++) {
      await publishOne(shelterId, cookie, index, {
        urgent: "si",
        urgentReason: `Motivo ${index}`,
      });
    }

    // The cap is a budget for the *mark*, not a limit on publishing.
    const plain = await publishOne(shelterId, cookie, 99);
    expect(plain.status).toBe(303);
  });

  it("lets a shelter reword the reason on its third urgent animal", async () => {
    const { shelterId, cookie } = await freshShelter();

    let last: Response | undefined;
    for (let index = 0; index < MAX_URGENT_PER_SHELTER; index++) {
      last = await publishOne(shelterId, cookie, index, {
        urgent: "si",
        urgentReason: `Motivo ${index}`,
      });
    }

    /**
     * The bug the obvious count produces. Editing the third urgent animal would read three
     * marks, find the cap reached and refuse a change that adds no mark — so the count
     * excludes the animal being saved.
     */
    const animalId = publishedId(last!);
    const response = await post(
      `/refugios/animales/${animalId}`,
      { ...EDIT_FORM, urgent: "si", urgentReason: "Motivo reescrito" },
      { cookie },
    );

    expect(response.status).toBe(303);
    const rows = await storedAnimals(shelterId);
    expect(rows.find((row) => row.id === animalId)!.urgentReason).toBe(
      "Motivo reescrito",
    );
  });
});

describe("the shelter's own page for one animal", () => {
  async function published() {
    const { shelterId, cookie, path } = await readyToPublish();
    const response = await post(path, PUBLISH_FORM, { cookie });
    return { shelterId, cookie, animalId: publishedId(response) };
  }

  it("404s another shelter's animal rather than 403", async () => {
    const { animalId } = await published();

    const stranger = await freshShelter("curioso@refugio.example");
    const response = await get(`/refugios/animales/${animalId}`, stranger.cookie);

    expect(response.status).toBe(404);
  });

  it("renders the animal and derives its age band at read time", async () => {
    const { cookie, animalId } = await published();

    const html = await (await get(`/refugios/animales/${animalId}`, cookie)).text();

    expect(html).toContain("Canela");
    expect(html).toContain("Valencia");
    /**
     * Born 2025-01-01 and well past twelve months, so the dog has graduated out of Cachorra on
     * its own with nothing having written to the row (ADR 0004). This is the coverage that used
     * to sit on the public page, which is now gated — see `routing.test.ts`.
     *
     * `Joven` and not `Young`: `deriveAgeBand()` returns the band as a domain value and
     * `ageBandLabel()` is what puts it into es-VE, per CONTEXT.md's vocabulary table.
     */
    expect(html).toContain('data-testid="age-band">Joven');
    expect(html).not.toContain("Young");
    expect(html).not.toContain("Cachorra");
  });

  it("says why the animal is not public yet, not merely that it is not", async () => {
    const { cookie, animalId } = await published();

    const html = await (await get(`/refugios/animales/${animalId}`, cookie)).text();

    // A shelter told only "no aparece" would hunt for something it did wrong on the form.
    expect(html).toContain("todavía no aparece en el sitio público");
    expect(html).toContain("esperando la verificación");
  });

  it("does not tell a refused shelter it is still waiting", async () => {
    const { shelterId, cookie, animalId } = await published();
    await decideShelter(shelterId, "Refused");

    const html = await (await get(`/refugios/animales/${animalId}`, cookie)).text();

    /**
     * Before issue #53 landed the log, every shelter was pending and one sentence covered them
     * all. Now `Refused` and `Revoked` exist, and telling a shelter that already has its answer
     * to keep waiting is the platform lying to itself — so it is pointed back at the mail that
     * invited a reply instead.
     */
    expect(html).toContain("todavía no aparece en el sitio público");
    expect(html).toContain("respóndele a ese correo");
    expect(html).not.toContain("esperando la verificación");
  });

  it("describes the animal with its gender agreed", async () => {
    const { cookie, animalId } = await published();

    const html = await (await get(`/refugios/animales/${animalId}`, cookie)).text();

    /**
     * `Canela` is female, so every word agrees and no disclaimer is appended. ADR 0018 exists
     * because the masculine forms — `Esterilizado`, `Mediano` — are what a naive renderer would
     * have shown, and they would have been wrong without ever failing.
     */
    expect(html).toContain("Perra joven");
    expect(html).toContain("Mediana");
    expect(html).toContain("Esterilizada");
    expect(html).not.toContain("sexo no registrado");
  });

  it("discloses the masculine when no sex was recorded", async () => {
    const { cookie, path } = await readyToPublish();
    const response = await post(path, { ...PUBLISH_FORM, sex: "Unknown" }, { cookie });
    const animalId = publishedId(response);

    const html = await (await get(`/refugios/animales/${animalId}`, cookie)).text();

    // Spanish's unmarked form is masculine, so the resolution is disclosed rather than assumed.
    expect(html).toContain("Perro joven");
    expect(html).toContain("sexo no registrado");
  });
});

describe("editing an animal", () => {
  async function published() {
    const { shelterId, cookie, path } = await readyToPublish();
    const response = await post(path, PUBLISH_FORM, { cookie });
    return { shelterId, cookie, animalId: publishedId(response) };
  }

  /**
   * Both timestamps pushed into the past, so the assertions below are about which one *moved*
   * rather than about millisecond resolution. Publishing sets the two to the same instant, and
   * an edit microseconds later would otherwise be indistinguishable from no change at all.
   */
  async function ageTimestamps(animalId: string, to: Date) {
    await env.DB.prepare(
      "UPDATE animals SET last_confirmed_at = ?, matchable_since = ? WHERE id = ?",
    )
      .bind(to.getTime(), to.getTime(), animalId)
      .run();
  }

  it("moves lastConfirmedAt and leaves matchableSince alone", async () => {
    const { shelterId, cookie, animalId } = await published();
    const past = new Date("2026-01-01");
    await ageTimestamps(animalId, past);

    const response = await post(
      `/refugios/animales/${animalId}`,
      { ...EDIT_FORM, description: "Ya camina con correa sin jalar." },
      { cookie },
    );
    expect(response.status).toBe(303);

    const [row] = await storedAnimals(shelterId);
    // "Any edit moves lastConfirmedAt" — every edit is a Confirmation.
    expect(row!.lastConfirmedAt.getTime()).toBeGreaterThan(past.getTime());
    // And the animal did not re-enter the pool, so the digest must not re-announce it.
    expect(row!.matchableSince.getTime()).toBe(past.getTime());
  });

  it("renames without changing anything a link depends on", async () => {
    const { shelterId, cookie, animalId } = await published();

    const response = await post(
      `/refugios/animales/${animalId}`,
      { ...EDIT_FORM, name: "Canelita" },
      { cookie },
    );
    expect(response.status).toBe(303);

    const [row] = await storedAnimals(shelterId);
    expect(row!.name).toBe("Canelita");
    // The id is the whole address, which is what makes the name free to change.
    expect(row!.id).toBe(animalId);
    expect(row!.uploadSessionId).toBe(`session-for-${shelterId}`);
  });

  it("changes the availability, and only a shelter's own action does", async () => {
    const { shelterId, cookie, animalId } = await published();

    await post(
      `/refugios/animales/${animalId}`,
      { ...EDIT_FORM, availability: "Adopted" },
      { cookie },
    );

    const [row] = await storedAnimals(shelterId);
    expect(row!.availability).toBe("Adopted");
  });

  it("clears the urgency mark when the box is unticked", async () => {
    const { shelterId, cookie, path } = await readyToPublish();
    const response = await post(
      path,
      { ...PUBLISH_FORM, urgent: "si", urgentReason: "Estaba urgente" },
      { cookie },
    );
    const animalId = publishedId(response);

    /**
     * An unticked checkbox is not submitted at all, so this posts the edit form *without* the
     * `urgent` field — exactly what a browser sends. Clearing the mark must always be possible,
     * or the cap would be a trap rather than a budget.
     */
    await post(`/refugios/animales/${animalId}`, EDIT_FORM, { cookie });

    const [row] = await storedAnimals(shelterId);
    expect(row!.urgentReason).toBeNull();
  });

  it("refuses an edit that would break the size pairing, and changes nothing", async () => {
    const { shelterId, cookie, animalId } = await published();

    // Turning the dog into a cat while it still carries a dog's size.
    const response = await post(
      `/refugios/animales/${animalId}`,
      { ...EDIT_FORM, species: "cat" },
      { cookie },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("El tamaño es solo para perros");

    const [row] = await storedAnimals(shelterId);
    expect(row!.species).toBe("dog");
    expect(row!.size).toBe("Medium");
  });

  it("shows the animal in the shelter's panel, so it can be reached at all", async () => {
    const { cookie, animalId } = await published();

    const html = await (await get("/refugios/panel", cookie)).text();

    expect(html).toContain(`/refugios/animales/${animalId}`);
    expect(html).toContain("Canela");
  });
});
