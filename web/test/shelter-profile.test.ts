import { env } from "cloudflare:test";
import {
  animals,
  createDb,
  oneTimeCodes,
  shelterContactPoints,
  shelters,
} from "@pawster/db";
import { isListed } from "@pawster/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import {
  SESSION_REFRESH_AFTER_MS,
  SIGN_IN_ADDRESS_COOLDOWN_MS,
} from "../src/lib/auth/policy.ts";
import { encodeSession } from "../src/lib/auth/session.ts";
import { readShelterFacts } from "../src/lib/auth/store.ts";
import {
  REGISTRATION,
  ageMailLedger,
  clearShelterTables,
  cookieFrom,
  get,
  post,
  register,
  requestCode,
  signIn,
} from "./support/shelter.ts";

/**
 * A shelter editing its own record, through the Worker's own front door.
 *
 * The ticket's premise is that everything about a shelter stays editable after verification,
 * "so that a new phone number is not a support request" — so most of what is asserted here
 * is that an edit lands. The three assertions that are about something sharper:
 *
 * - **the slug does not move**, whatever the request carries, because it is an address
 *   adopters and search engines already hold;
 * - **the last contact point cannot be removed**, because `isListed()` has a
 *   `contactPointCount > 0` clause and emptying it delists every animal the shelter has
 *   published, silently;
 * - **changing the account email ends everything the old address could do** — every live
 *   session and the outstanding One-Time Code — because that address is the whole credential.
 */

const PROFILE = "/refugios/perfil";
const EMAIL_FORM = "/refugios/correo";

/** The registration fixture's one filled contact row, as it is stored. */
const REGISTERED_CONTACT = { kind: "whatsapp", value: "+58 412 5550001" };

/** A complete, valid profile form. Individual tests override one field at a time. */
const PROFILE_FORM = {
  displayName: "Refugio Los Teques",
  baseRegion: "Miranda",
  contactPosition: ["1"],
  contactKind: ["whatsapp"],
  contactValue: [REGISTERED_CONTACT.value],
};

async function storedContactPoints(shelterId: string) {
  const db = createDb(env.DB);
  return await db
    .select({
      kind: shelterContactPoints.kind,
      value: shelterContactPoints.value,
      position: shelterContactPoints.position,
    })
    .from(shelterContactPoints)
    .where(eq(shelterContactPoints.shelterId, shelterId))
    .orderBy(shelterContactPoints.position);
}

async function storedShelter(shelterId: string) {
  const db = createDb(env.DB);
  const [row] = await db.select().from(shelters).where(eq(shelters.id, shelterId));
  return row!;
}

/** One published animal, so the public surfaces have something to render. */
async function seedAnimal(shelterId: string): Promise<void> {
  await createDb(env.DB).insert(animals).values({
    id: "animal-1",
    shelterId,
    name: "Canela",
    species: "dog",
    estimatedBirthDate: new Date("2025-01-01"),
    region: "Miranda",
    lastConfirmedAt: new Date("2026-08-30"),
  });
}

beforeEach(clearShelterTables);

describe("reaching the profile at all", () => {
  it("turns away a request with no session, on GET and on POST", async () => {
    for (const path of [PROFILE, EMAIL_FORM]) {
      const read = await get(path);
      expect(read.status, `GET ${path}`).toBe(303);
      expect(read.headers.get("location")).toBe("/refugios/entrar");

      /**
       * A 303 to the sign-in form rather than a 401, because there is no credential to
       * re-present: the shelter has to go and fetch a new code, so pointing at the form that
       * sends one is the only useful answer. The same choice `panel.astro` makes.
       */
      const write = await post(path, PROFILE_FORM);
      expect(write.status, `POST ${path}`).toBe(303);
      expect(write.headers.get("location")).toBe("/refugios/entrar");
    }
  });

  it("is reachable from the panel, so a shelter can find it without being told a URL", async () => {
    const { cookie } = await signIn();

    const panel = await get("/refugios/panel", cookie);
    expect(await panel.text()).toContain(`href="${PROFILE}"`);
  });

  it("shows what is stored, and shows the slug without offering to change it", async () => {
    const { cookie } = await signIn();

    const body = await (await get(PROFILE, cookie)).text();

    expect(body).toContain(REGISTRATION.displayName);
    expect(body).toContain(REGISTRATION.baseRegion);
    expect(body).toContain(REGISTERED_CONTACT.value);
    expect(body).toContain("/refugios/refugio-los-teques");

    /**
     * The slug is rendered as text, never as a control. Asserted on the *absence of an input*
     * rather than on the page's words, because a hidden input would read as fine to a human
     * and would be exactly the thing that makes a slug editable.
     */
    expect(body).not.toMatch(/name="slug"/);
  });
});

describe("editing the display name and the base region", () => {
  it("saves both, and answers 303 so a reload does not re-submit", async () => {
    const { shelterId, cookie } = await signIn();

    const response = await post(
      PROFILE,
      { ...PROFILE_FORM, displayName: "Refugio Los Teques y Sus Perros", baseRegion: "Aragua" },
      { cookie },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/perfil?guardado");

    const shelter = await storedShelter(shelterId);
    expect(shelter.displayName).toBe("Refugio Los Teques y Sus Perros");
    expect(shelter.baseRegion).toBe("Aragua");
  });

  it("carries the sliding refresh across the redirect it answers with", async () => {
    /**
     * A redirect is a fresh response and does not inherit the headers staged on
     * `Astro.response`, so the `Set-Cookie` `authenticate()` hands back has to be copied onto
     * it by hand. Without this the one request a shelter makes in a week — a save — would be
     * the one that declined to extend its session.
     *
     * The cookie is minted aged rather than waited for: `encodeSession` takes the issued-at
     * as an argument precisely so that nothing has to.
     */
    const { shelterId } = await signIn();
    const aged = await encodeSession(env.SESSION_SECRET, {
      shelterId,
      issuedAt: new Date(Date.now() - SESSION_REFRESH_AFTER_MS - 1_000),
      epoch: 0,
    });

    const response = await post(PROFILE, PROFILE_FORM, {
      cookie: `pawster_session=${aged}`,
    });

    expect(response.status).toBe(303);
    const refreshed = cookieFrom(response, "pawster_session");
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(`pawster_session=${aged}`);
  });

  it("says so on the page it redirects to", async () => {
    const { cookie } = await signIn();
    await post(PROFILE, PROFILE_FORM, { cookie });

    const body = await (await get(`${PROFILE}?guardado`, cookie)).text();
    expect(body).toContain("se guardaron los cambios");
  });

  it("reaches the public page an adopter reads", async () => {
    /**
     * The point of the display name being editable: an adopter sees the new one. The animal
     * page joins `shelters.display_name`, so this is the same edit arriving at the one
     * surface that quotes it.
     */
    const { shelterId, cookie } = await signIn();
    await seedAnimal(shelterId);

    await post(PROFILE, { ...PROFILE_FORM, displayName: "Patitas de Miranda" }, { cookie });

    const body = await (await get("/animales/animal-1")).text();
    expect(body).toContain("Patitas de Miranda");
  });

  it("edits while the shelter is still awaiting verification", async () => {
    /**
     * Half of the ticket's "before and after verification", and the half that is assertable
     * today. ADR 0003 makes pending the *absence* of a verification entry, so a freshly
     * registered shelter is pending and `isListed()` says nothing of its is visible — and the
     * save below lands anyway.
     *
     * The other half is unconditional rather than untested: **no code path on either profile
     * page reads verification standing**, so there is no branch for a verified shelter to
     * take. It cannot be asserted from outside yet because there is no way to *make* a
     * shelter verified — the append-only log lands with issue #53, and until it does
     * `readShelterFacts()` reports `latestVerificationOutcome: null` for everyone. When #53
     * arrives, this test gains a second case and needs no new production code.
     */
    const { shelterId, cookie } = await signIn();
    const db = createDb(env.DB);

    const facts = await readShelterFacts(db, shelterId);
    expect(facts!.latestVerificationOutcome).toBeNull();
    expect(isListed({ availability: "Available" }, facts!)).toBe(false);

    const response = await post(
      PROFILE,
      { ...PROFILE_FORM, displayName: "Refugio Sin Verificar" },
      { cookie },
    );

    expect(response.status).toBe(303);
    expect((await storedShelter(shelterId)).displayName).toBe("Refugio Sin Verificar");
  });
});

describe("the slug", () => {
  it("does not move when the display name does", async () => {
    const { shelterId, cookie } = await signIn();
    const before = (await storedShelter(shelterId)).slug;

    await post(PROFILE, { ...PROFILE_FORM, displayName: "Otro Nombre Por Completo" }, { cookie });

    expect((await storedShelter(shelterId)).slug).toBe(before);
    expect(before).toBe("refugio-los-teques");
  });

  it("ignores a `slug` field a hand-made request sends", async () => {
    /**
     * Not refused — *not read*. There is no `slug` in `ProfileInput` and no query outside
     * `registerShelter()` may write the column, which
     * `scripts/check-source-rules.mjs`'s third rule fails the build over. This test covers
     * the behaviour; that rule covers the route nobody has written yet.
     */
    const { shelterId, cookie } = await signIn();

    const response = await post(
      PROFILE,
      { ...PROFILE_FORM, slug: "refugio-secuestrado" },
      { cookie },
    );

    expect(response.status).toBe(303);
    expect((await storedShelter(shelterId)).slug).toBe("refugio-los-teques");
  });
});

describe("contact points", () => {
  it("stores them in the order the shelter numbered them, from position 0", async () => {
    const { shelterId, cookie } = await signIn();

    await post(
      PROFILE,
      {
        ...PROFILE_FORM,
        // Numbered out of document order on purpose: WhatsApp is submitted last and asked
        // for first, because the order is the shelter's decision and not the form's layout.
        contactPosition: ["3", "2", "1"],
        contactKind: ["email", "instagram", "whatsapp"],
        contactValue: ["hola@refugio.example", "@refugio", "+58 412 5550001"],
      },
      { cookie },
    );

    expect(await storedContactPoints(shelterId)).toEqual([
      { kind: "whatsapp", value: "+58 412 5550001", position: 0 },
      { kind: "instagram", value: "@refugio", position: 1 },
      { kind: "email", value: "hola@refugio.example", position: 2 },
    ]);
  });

  it("reorders them on a second save, leaving no gap and no duplicate position", async () => {
    const { shelterId, cookie } = await signIn();

    const three = {
      ...PROFILE_FORM,
      contactPosition: ["1", "2", "3"],
      contactKind: ["whatsapp", "instagram", "email"],
      contactValue: ["+58 412 5550001", "@refugio", "hola@refugio.example"],
    };
    await post(PROFILE, three, { cookie });

    // The shelter decides it actually answers Instagram, and moves it to the front.
    await post(PROFILE, { ...three, contactPosition: ["2", "1", "3"] }, { cookie });

    expect(await storedContactPoints(shelterId)).toEqual([
      { kind: "instagram", value: "@refugio", position: 0 },
      { kind: "whatsapp", value: "+58 412 5550001", position: 1 },
      { kind: "email", value: "hola@refugio.example", position: 2 },
    ]);
  });

  it("adds one and removes one in a single save", async () => {
    const { shelterId, cookie } = await signIn();

    await post(
      PROFILE,
      {
        ...PROFILE_FORM,
        contactPosition: ["1", "2"],
        contactKind: ["whatsapp", "instagram"],
        // The WhatsApp row emptied and an Instagram row filled: one save, one net change of
        // channel, and the surviving point renumbered to 0 rather than left on 1.
        contactValue: ["", "@refugio"],
      },
      { cookie },
    );

    expect(await storedContactPoints(shelterId)).toEqual([
      { kind: "instagram", value: "@refugio", position: 0 },
    ]);
  });

  it("refuses to remove the last one, says why, and changes nothing at all", async () => {
    const { shelterId, cookie } = await signIn();

    const response = await post(
      PROFILE,
      {
        ...PROFILE_FORM,
        displayName: "Nombre Que No Se Debe Guardar",
        contactValue: [""],
      },
      { cookie },
    );

    /**
     * 200 and the form again, not a redirect: the shelter is being shown a refusal it has to
     * act on, with what it typed still in the fields.
     */
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("dejan de aparecer en el sitio");

    // The contact point survives, and so does the old display name — the whole save is
    // refused rather than the offending field being dropped from it.
    expect(await storedContactPoints(shelterId)).toEqual([
      { ...REGISTERED_CONTACT, position: 0 },
    ]);
    expect((await storedShelter(shelterId)).displayName).toBe(REGISTRATION.displayName);
  });

  it("keeps the shelter's other edits visible on the refused form", async () => {
    // Otherwise the refusal is destructive: a shelter that renamed itself *and* emptied its
    // last contact row would lose the rename to a rule about something else.
    const { cookie } = await signIn();

    const body = await (
      await post(
        PROFILE,
        { ...PROFILE_FORM, displayName: "Nombre Recién Escrito", contactValue: [""] },
        { cookie },
      )
    ).text();

    expect(body).toContain("Nombre Recién Escrito");
  });
});

describe("changing the account email", () => {
  const NEW_EMAIL = "nuevo@refugio.example";

  const emailForm = (accountEmail: string, again = accountEmail) => ({
    accountEmail,
    accountEmailAgain: again,
  });

  it("moves the address, bumps sessionEpoch and signs the acting session out", async () => {
    const { shelterId, cookie } = await signIn();
    expect((await storedShelter(shelterId)).sessionEpoch).toBe(0);

    const response = await post(EMAIL_FORM, emailForm(NEW_EMAIL), { cookie });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/correo/listo");

    const shelter = await storedShelter(shelterId);
    expect(shelter.accountEmail).toBe(NEW_EMAIL);
    /**
     * The whole revocation mechanism (ADR 0013): one integer, and every live cookie minted
     * under the old value is refused by `guard.ts`. There is no session table to walk.
     */
    expect(shelter.sessionEpoch).toBe(1);

    // The browser is told too, rather than being left to discover it on its next click.
    const cleared = response.headers
      .getSetCookie()
      .find((header) => header.startsWith("pawster_session="));
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Max-Age=0");
  });

  it("kills every live session and not only the one that acted", async () => {
    const { cookie } = await signIn();
    await post(EMAIL_FORM, emailForm(NEW_EMAIL), { cookie });

    /**
     * The same cookie, replayed as another device would have replayed it. A shared account
     * email means shared sessions (ADR 0008: "forwarding is delegation"), so "signed out" has
     * to mean every phone the shelter's volunteers hold, not just this browser.
     */
    for (const path of ["/refugios/panel", PROFILE, EMAIL_FORM]) {
      const response = await get(path, cookie);
      expect(response.status, path).toBe(303);
      expect(response.headers.get("location")).toBe("/refugios/entrar");
    }
  });

  it("kills an outstanding one-time code, which was mailed to the old address", async () => {
    const { shelterId, cookie } = await signIn();

    /**
     * A code outstanding at the moment of the change. `signIn()` spent the first one, so the
     * ledger is aged past the five-minute per-address cooldown to ask for a second.
     */
    await ageMailLedger(SIGN_IN_ADDRESS_COOLDOWN_MS + 1);
    // `signIn()` already spent one send, and `requestCode()` asserts it can see exactly one
    // email in the interceptor's log — so the log is cleared rather than the assertion loosened.
    outbound.reset();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);

    const db = createDb(env.DB);
    expect(
      await db.select().from(oneTimeCodes).where(eq(oneTimeCodes.shelterId, shelterId)),
    ).toHaveLength(1);

    await post(EMAIL_FORM, emailForm(NEW_EMAIL), { cookie });

    // Gone from the table, which is what "outstanding" means — a row's existence, not a flag.
    expect(
      await db.select().from(oneTimeCodes).where(eq(oneTimeCodes.shelterId, shelterId)),
    ).toHaveLength(0);

    /**
     * And it no longer opens anything. Whoever still holds the old inbox is exactly the
     * person the handover takes the account away from, so leaving that code alive would have
     * given them ten more minutes of it.
     */
    const attempt = await post("/api/refugios/sesion", { code }, { cookie: token! });
    expect(attempt.status).toBe(303);
    expect(attempt.headers.get("location")).toBe("/refugios/entrar/codigo-invalido");
  });

  it("refuses an address another shelter already holds, without touching anything", async () => {
    const { shelterId, cookie } = await signIn();
    // A second shelter, which registration alone creates: no mail is sent at registration.
    await register({ accountEmail: "otro@refugio.example", displayName: "Otro Refugio" });

    const response = await post(EMAIL_FORM, emailForm("otro@refugio.example"), { cookie });

    /**
     * Refused out loud, which is the one place this platform departs from ADR 0008's
     * identical-response rule — `changeAccountEmail()` carries the reasoning. The
     * alternative is a shelter told its email moved when it did not, which it discovers the
     * next time it needs a code, for a loss the platform manufactured.
     */
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No se puede usar ese correo");

    const shelter = await storedShelter(shelterId);
    expect(shelter.accountEmail).toBe(REGISTRATION.accountEmail);
    expect(shelter.sessionEpoch).toBe(0);
  });

  it("refuses the address it already has, rather than signing everyone out for nothing", async () => {
    const { shelterId, cookie } = await signIn();

    const response = await post(
      EMAIL_FORM,
      emailForm(REGISTRATION.accountEmail.toUpperCase()),
      { cookie },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Ese ya es el correo del refugio");
    // The epoch is the assertion: a "successful" no-op here would have cost every session.
    expect((await storedShelter(shelterId)).sessionEpoch).toBe(0);
  });

  it("refuses a confirmation that does not match, and changes nothing", async () => {
    const { shelterId, cookie } = await signIn();

    const response = await post(
      EMAIL_FORM,
      emailForm(NEW_EMAIL, "nuevo@refugio.exampl"),
      { cookie },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("no son iguales");

    const shelter = await storedShelter(shelterId);
    expect(shelter.accountEmail).toBe(REGISTRATION.accountEmail);
    expect(shelter.sessionEpoch).toBe(0);
  });

  it("mutates nothing on a GET, so a prefetcher cannot hand the account away", async () => {
    /**
     * The rule ADR 0008 states for emailed links, applied here because the consequence is the
     * same shape and worse: a link prefetcher or mail scanner that could move an account
     * email would revoke a shelter's sessions by looking at a page.
     */
    const { shelterId, cookie } = await signIn();

    const response = await get(EMAIL_FORM, cookie);
    expect(response.status).toBe(200);

    const shelter = await storedShelter(shelterId);
    expect(shelter.accountEmail).toBe(REGISTRATION.accountEmail);
    expect(shelter.sessionEpoch).toBe(0);
  });

  it("says what the change costs before asking for the address", async () => {
    // The page ADR 0013 calls "a question of identity, answered out of band" if it goes
    // wrong. A shelter has to be able to read the consequences without submitting anything.
    const { cookie } = await signIn();

    const body = await (await get(EMAIL_FORM, cookie)).text();
    expect(body).toContain("Se cierra la sesión en todos los teléfonos");
    expect(body).toContain("deja de servir");
    expect(body).toContain('name="accountEmailAgain"');
  });

  it("lands on a page that needs no session to render", async () => {
    /**
     * Prerendered, and it has to be: by the time it is rendered the shelter has no session
     * left. The asset store is asked directly, which is the assertion that actually fails if
     * someone adds `prerender = false` to it — `SELF.fetch` would render it either way.
     */
    const asset = await env.ASSETS.fetch("https://pawster.test/refugios/correo/listo");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Se cerró la sesión en todos lados");
  });
});

describe("the account email is never published", () => {
  it("appears in no public page's source", async () => {
    const { shelterId, cookie } = await signIn();
    await seedAnimal(shelterId);

    /**
     * `CONTEXT.md`, *Account Email*: "Never published — adopters reach a shelter through its
     * contact points." The two surfaces that exist today are the listing and the animal page,
     * and both are fetched **without a cookie**, the way an adopter fetches them.
     *
     * The filter index and the public shelter page are not checked here because neither
     * exists yet (issues #56 and #57). What protects them is upstream of a test: the address
     * is not in any type either of them will be built from — `ShelterProfile` is the only
     * shape carrying it, and it is read by the two authenticated pages alone.
     */
    for (const path of ["/", "/animales/animal-1"]) {
      const body = await (await get(path)).text();
      expect(body, path).not.toContain(REGISTRATION.accountEmail);
    }

    // And it *is* on the shelter's own page, so the test above is not passing by accident.
    expect(await (await get(PROFILE, cookie)).text()).toContain(REGISTRATION.accountEmail);
  });

  it("is not what an adopter is offered, even when a contact point holds the same string", async () => {
    /**
     * An `email` contact point and `shelters.account_email` are two different facts that may
     * hold one string, and only one of them is ever rendered. A shelter that publishes its
     * account email *as* a contact point has made that choice itself, and the platform still
     * never reads the credential column to do it.
     */
    const { shelterId, cookie } = await signIn();

    await post(
      PROFILE,
      {
        ...PROFILE_FORM,
        contactPosition: ["1"],
        contactKind: ["email"],
        contactValue: [REGISTRATION.accountEmail],
      },
      { cookie },
    );

    const points = await storedContactPoints(shelterId);
    expect(points).toEqual([
      { kind: "email", value: REGISTRATION.accountEmail, position: 0 },
    ]);
    // The credential column is untouched by having been typed into a public field.
    expect((await storedShelter(shelterId)).accountEmail).toBe(REGISTRATION.accountEmail);
  });
});

describe("the shelter record", () => {
  it("has no verified column and no legal-name column", async () => {
    /**
     * Both absences are decisions, asserted here so that a later ticket adding either has to
     * argue with a failing test rather than with a comment.
     *
     * `verified` is ruled out by ADR 0003: standing is an append-only log and a shelter's
     * current standing is its latest entry, so a boolean beside that log is a second answer
     * that can disagree with it — and one that cannot say *why* a judgement was made. A legal
     * name is ruled out by having no reader: it would be evidence inside a verification
     * entry, not a column held on every shelter.
     *
     * The whole column list is asserted rather than the two absences, because a test that
     * only forbids two names passes for a `verified_at` or a `razon_social`.
     */
    const { results } = await env.DB.prepare("PRAGMA table_info(shelters)").all<{
      name: string;
    }>();

    expect(results.map((column) => column.name).sort()).toEqual([
      "account_email",
      "base_region",
      "country_code",
      "created_at",
      "display_name",
      "id",
      "session_epoch",
      "slug",
    ]);
  });
});
