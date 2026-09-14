import {
  createDb,
  shelterContactPoints,
  shelters,
  type ContactPointKind,
} from "@pawster/db";
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { derivativeKey } from "../src/lib/photos/keys.ts";
import { MAYBE_GONE } from "../src/lib/animals/words.ts";
import { seedAnimal, type SeedAnimalOptions } from "./support/animal.ts";
import { clearShelterTables, verifyShelter } from "./support/shelter.ts";

/**
 * The animal page, the contact hand-off and the archive page — issue #57, from outside.
 *
 * Every request goes through `SELF.fetch()`, which is the whole Worker including the asset
 * router, against a real local D1 with the real migrations applied. Nothing here calls a
 * handler directly, because half of what is being asserted is *which* of the two worlds answers
 * a given URL.
 *
 * The pure halves are tested where they are pure and are not re-asserted here:
 * `animal-address.test.ts` for the address, `animal-contact.test.ts` for the hand-off,
 * `animal-visibility.test.ts` for which of the three answers an animal gets, and
 * `words.test.ts` for the phrases. What is left for this file is the wiring — that the page
 * asks those questions at all, and that the answers reach the HTML.
 */

const ORIGIN = "https://pawster.test";
const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`);

/** The digest `support/animal.ts` stamps on a session's photo at `position`. */
const photoDigest = (position: number) => `${"0".repeat(63)}${position}`;

interface SeedOptions extends SeedAnimalOptions {
  /** In the shelter's own order. The first is the one the page offers as a filled button. */
  readonly contacts?: readonly (readonly [ContactPointKind, string])[];
  /** Skipped to leave the shelter awaiting verification, which is the 404 case. */
  readonly verified?: boolean;
}

/**
 * A verified shelter, its contact points in order, and one of its animals.
 *
 * Written directly rather than through the publishing form: this suite is not testing
 * publishing, and driving four screens to reach a page under test would make every failure here
 * ambiguous. The verification entry is the exception and goes through the real write path —
 * `verifyShelter()` appends to the log `readShelterFacts()` actually reads, so the gate being
 * wired to something other than the log fails here rather than passing against a fixture.
 */
async function seedListedAnimal(options: SeedOptions = {}): Promise<void> {
  const db = createDb(env.DB);

  await db.insert(shelters).values({
    id: "shelter-1",
    slug: "refugio-los-teques",
    displayName: "Refugio Los Teques",
    accountEmail: "hola@refugio.example",
    baseRegion: "Miranda",
    countryCode: "VE",
    createdAt: new Date("2026-01-01"),
  });

  const contacts = options.contacts ?? [["whatsapp", "+58 412 5550001"]];
  for (const [position, [kind, value]] of contacts.entries()) {
    await db.insert(shelterContactPoints).values({
      id: `contact-${position}`,
      shelterId: "shelter-1",
      kind,
      value,
      position,
      createdAt: new Date("2026-01-01"),
    });
  }

  await seedAnimal({ shelterId: "shelter-1", ...options });
  if (options.verified !== false) await verifyShelter("shelter-1", "Refugio Los Teques");
}

beforeEach(clearShelterTables);

describe("the address", () => {
  it("resolves on the id alone, whatever the name segment says", async () => {
    await seedListedAnimal();

    /**
     * The acceptance criterion, and the whole reason the name is a *decorative* slug: shelters
     * rename animals constantly, so every forward of an old link has to keep working. The last
     * of these is a name that was never this animal's, which is the renamed case observed from
     * the outside — nothing on the platform records what an animal used to be called.
     */
    for (const path of [
      "/a/animal-1",
      "/a/animal-1/canela",
      "/a/animal-1/callejero",
      "/a/animal-1/cualquier-cosa",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('data-testid="animal-name">Canela');
    }
  });

  it("declares one canonical spelling, because it answers to infinitely many", async () => {
    await seedListedAnimal();

    // Without this, every forward with a stale name segment is a duplicate page to a search
    // engine, and the platform has arbitrarily many of them per animal.
    const html = await (await get("/a/animal-1/nombre-viejo")).text();
    expect(html).toContain(
      `<link rel="canonical" href="${ORIGIN}/a/animal-1/canela">`,
    );
  });

  it("is rendered per request rather than served from the asset store", async () => {
    await seedListedAnimal();

    /**
     * The criterion's "the route is server-rendered", asserted the way `routing.test.ts` asserts
     * the opposite for `/`: the asset binding is asked directly. A prerendered route has a file
     * in `dist/client/` and this returns 200; an SSR route has none and this returns 404, while
     * `SELF.fetch` returns 200 either way — which is exactly why a status check through `SELF`
     * cannot see the difference.
     *
     * The other half of that criterion is CPU, which no test can observe: `npm run check:ssr-cpu`
     * measures it and `docs/measurements.md` records the figure against the 10 ms ceiling.
     */
    const asset = await env.ASSETS.fetch(`${ORIGIN}/a/animal-1/canela`);
    expect(asset.status).toBe(404);
    expect((await get("/a/animal-1/canela")).status).toBe(200);
  });
});

describe("what the page says about staleness", () => {
  it("states the consequence, and states it on the page only", async () => {
    await seedListedAnimal({ lastConfirmedAt: new Date("2026-05-01") });

    const html = await (await get("/a/animal-1/canela")).text();

    expect(html).toContain("por el refugio");
    expect(html).toContain(MAYBE_GONE);

    /**
     * The other half of the criterion: nowhere on the listing card. The card is issue #56's and
     * the listing is still a stub, so what this can assert today is that the consequence has not
     * leaked onto the one public surface that already exists. It becomes the real assertion the
     * moment #56 renders a card, which is why it is written now rather than left as a note.
     */
    expect(await (await get("/")).text()).not.toContain(MAYBE_GONE);
  });

  it("escalates the emphasis rather than the sentence", async () => {
    // The sentence is unconditional — see `confirmationSentence()` — and only the band moves,
    // which is what the page styles amber.
    await seedListedAnimal({ lastConfirmedAt: new Date("2026-09-07") });
    const fresh = await (await get("/a/animal-1/canela")).text();
    expect(fresh).toContain('data-staleness="Fresh"');
    expect(fresh).toContain(MAYBE_GONE);

    await clearShelterTables();
    await seedListedAnimal({ lastConfirmedAt: new Date("2026-01-01") });
    const stale = await (await get("/a/animal-1/canela")).text();
    expect(stale).toContain('data-staleness="Stale"');
    expect(stale).toContain(MAYBE_GONE);
  });
});

describe("the age and its basis", () => {
  it("never lets a shelter's guess read as a documented date", async () => {
    /**
     * `support/animal.ts` seeds `ageEstimateBasis: "ShelterGuess"`, which is the common case and
     * the dangerous one: an adopter reading `2 años` beside a stated birthday would be reading a
     * fact nobody claimed.
     */
    await seedListedAnimal();

    const html = await (await get("/a/animal-1/canela")).text();
    expect(html).toContain('data-testid="age">unos 2 años (estimada por el refugio)');
    // And no raw date anywhere: the animal carries an estimate, not a birthday.
    expect(html).not.toContain("2025-01-01");
  });
});

describe("the contact hand-off", () => {
  it("offers the shelter's first point as a filled button and the rest as a row", async () => {
    await seedListedAnimal({
      contacts: [
        ["whatsapp", "+58 412 5550001"],
        ["instagram", "@refugiolosteques"],
        ["email", "adopciones@refugio.example"],
      ],
    });

    const html = await (await get("/a/animal-1/canela")).text();

    /**
     * Keyed off the shelter's own ordering: position 0 is the channel it actually answers
     * (`CONTEXT.md`, *Contact Point*). Four equal buttons hand an adopter a decision they have
     * no basis for making, which is the alternative the prototype measured and rejected.
     */
    expect(html).toContain('data-testid="contact-first" data-kind="whatsapp"');
    expect(html).toContain("Escribir por WhatsApp");

    const others = html.slice(html.indexOf('data-testid="contact-rest"'));
    expect(others).toContain('data-kind="instagram"');
    expect(others).toContain('data-kind="email"');
    // The primary is not repeated in the row it is the alternative to.
    expect(others.slice(0, others.indexOf("</ul>"))).not.toContain("whatsapp");
  });

  it("renders no row at all for a shelter with one contact point", async () => {
    await seedListedAnimal();

    const html = await (await get("/a/animal-1/canela")).text();
    expect(html).toContain('data-testid="contact-first"');
    expect(html).not.toContain('data-testid="contact-rest"');
  });

  it("hands WhatsApp a message naming the animal and its short id", async () => {
    await seedListedAnimal();

    const html = await (await get("/a/animal-1/canela")).text();

    /**
     * The acceptance criterion, and the only join between the platform and the conversation:
     * contact is off-platform, so this message is the whole of what tells a shelter which animal
     * a stranger is writing about.
     */
    const prefill = "Hola, les escribo por Canela (pawster.test/a/animal-1). ¿Sigue disponible?";
    expect(html).toContain(`href="https://wa.me/584125550001?text=${encodeURIComponent(prefill)}"`);
    // And it is shown to the adopter before they send it, rather than only carried in the link.
    expect(html).toContain(prefill);
  });

  it("promises no prefill where no channel can carry one", async () => {
    // Instagram's profile URL has no message parameter and a phone call has no text, so a
    // shelter reachable only that way must not be shown a quoted message that never arrives.
    await seedListedAnimal({
      contacts: [
        ["instagram", "@refugiolosteques"],
        ["phone", "+58 212 5550001"],
      ],
    });

    const html = await (await get("/a/animal-1/canela")).text();
    expect(html).toContain('data-testid="contact-first" data-kind="instagram"');
    expect(html).not.toContain('data-testid="prefill"');
  });

  it("says the conversation leaves Pawster", async () => {
    await seedListedAnimal();
    expect(await (await get("/a/animal-1/canela")).text()).toContain(
      "La conversación sigue fuera de Pawster",
    );
  });
});

describe("the social preview", () => {
  it("points at the 1200×630 derivative of the primary photo", async () => {
    await seedListedAnimal({ photoCount: 3 });

    const html = await (await get("/a/animal-1/canela")).text();

    /**
     * Sharing is how a listing spreads here — a Venezuelan adopter meets Pawster through a
     * WhatsApp forward — so the preview card is load-bearing rather than SEO hygiene. WhatsApp
     * reads `og:image`, `og:title` and `og:description` and nothing else.
     *
     * The key is recomputed here rather than pasted, which is what makes this an assertion about
     * the *pipeline* rather than about a string: it is the same content-addressed key the
     * upload path wrote (ADR 0012), derived from the digest and the spec.
     */
    const expected = await derivativeKey(photoDigest(0), "socialPreview");
    expect(html).toContain(
      `<meta property="og:image" content="${env.MEDIA_PUBLIC_ORIGIN}/${expected}">`,
    );
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    // JPEG, for the reason `digestThumbnail` is one: a format the consumer silently drops
    // leaves a preview card with an empty image box.
    expect(expected.endsWith(".jpg")).toBe(true);

    expect(html).toContain('<meta property="og:title" content="Canela — Perra joven');
    expect(html).toContain('<meta property="og:description" content="Cariñosa y tranquila.">');
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/a/animal-1/canela">`);
  });

  it("is the primary photo and not whichever photo the gallery starts with", async () => {
    // Position 0 is the primary and a shelter chooses it by ordering (`CONTEXT.md`), so the
    // preview must come from that row and not from an arbitrary one.
    await seedListedAnimal({ photoCount: 3 });

    const html = await (await get("/a/animal-1/canela")).text();
    const second = await derivativeKey(photoDigest(1), "socialPreview");
    expect(html).not.toContain(second);
  });

  it("serves photographs from R2 rather than through the Worker", async () => {
    /**
     * ADR 0014: no R2 custom domain, images straight off `r2.dev`, no Worker in the path. A
     * build that pointed the media origin at the site origin would turn every image view into a
     * Worker invocation against the 100,000 requests/day cap, and nothing would fail visibly.
     */
    await seedListedAnimal({ photoCount: 2 });

    const html = await (await get("/a/animal-1/canela")).text();
    const gallery = html.slice(html.indexOf('data-testid="gallery"'));

    const detail = await derivativeKey(photoDigest(0), "detailImage");
    expect(gallery).toContain(`${env.MEDIA_PUBLIC_ORIGIN}/${detail}`);
    // The box is reserved before the bytes arrive: a 1600×1200 source scaled into the 1280 box.
    expect(gallery).toContain('width="1280" height="960"');
    expect(gallery).not.toContain(`src="${ORIGIN}/`);
  });
});

describe("the archive page", () => {
  it("is reachable, and tells an adopter the animal found a home", async () => {
    await seedListedAnimal({ availability: "Adopted" });

    const response = await get("/a/animal-1/canela");
    const html = await response.text();

    /**
     * A 200 and not a 404. `CONTEXT.md`: the page "stays reachable and says what happened [...]
     * an animal is never deleted", and the good ending is the reason the promise is worth
     * keeping — an adopter arriving late at a forwarded link learns the animal she was about to
     * write about is home.
     */
    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="archive-headline">Encontró casa');
    expect(html).toContain("ya fue adoptada");
    // Attributed, because Pawster witnessed no adoption.
    expect(html).toContain("El refugio dice");
  });

  it("words an unavailable animal differently, and offers nobody to write to", async () => {
    await seedListedAnimal({ availability: "NoLongerAvailable" });

    const response = await get("/a/animal-1/canela");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="archive-headline">Ya no está disponible');
    expect(html).not.toContain("Encontró casa");
    // There is nothing left to ask about, so the hand-off is absent rather than dead.
    expect(html).not.toContain('data-testid="contact"');
    expect(html).not.toContain("wa.me");
    // And the facts table goes with it: an archive page laying out adult size and sterilisation
    // would be describing an animal on offer.
    expect(html).not.toContain('data-testid="age"');
  });

  it("renders for an animal whose photos have already been dropped", async () => {
    /**
     * Photos drop on the ordinary twelve-month clock, so an old archive page has nothing to
     * show. The acceptance criterion is that it still renders — and the page says the absence
     * was a decision rather than leaving a gap that reads as broken.
     */
    await seedListedAnimal({ availability: "Adopted", photoCount: 0 });

    const response = await get("/a/animal-1/canela");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="archive-headline">Encontró casa');
    expect(html).toContain('data-testid="photos-dropped"');
    expect(html).not.toContain('data-testid="gallery"');
    // No image tags and no preview pointing at an object that no longer exists.
    expect(html).not.toContain("og:image");
  });

  it("still names the shelter that published the animal", async () => {
    // ADR 0015 keeps a departed shelter's display name for exactly this: "the archive is a
    // promise made to adopters rather than to the shelter".
    await seedListedAnimal({ availability: "Adopted" });
    expect(await (await get("/a/animal-1/canela")).text()).toContain(
      'data-testid="shelter-name">Refugio Los Teques',
    );
  });

  it("is not what an unverified shelter's animal gets", async () => {
    /**
     * The asymmetry worth asserting: three of `isListed()`'s four clauses produce an archive
     * page and verification produces nothing at all. The animal was never publicly reachable,
     * so there is no promise to keep — and a page would leak both that the id is real and that
     * the shelter is not verified.
     */
    await seedListedAnimal({ availability: "Adopted", verified: false });

    const response = await get("/a/animal-1/canela");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Canela");
  });
});

describe("what the page never shows", () => {
  it("does not carry the shelter's account email", async () => {
    /**
     * The acceptance criterion, asserted against a **fully rendered** page — photographs,
     * contact hand-off, shelter block and all — which is the version `shelter-profile.test.ts`
     * cannot assert, because the shelter there is unverified and the page it fetches is a 404
     * body.
     *
     * What makes it true is upstream of this test: the page reads
     * `readShelterPublicIdentity()`, which does not select the column, and
     * `scripts/check-source-rules.mjs` refuses any file outside the three readers that names it.
     */
    await seedListedAnimal({
      contacts: [
        ["whatsapp", "+58 412 5550001"],
        ["email", "adopciones@refugio.example"],
      ],
    });

    const html = await (await get("/a/animal-1/canela")).text();

    expect(html).not.toContain("hola@refugio.example");
    // And the contact point that *is* an address is published, so the assertion above is not
    // passing because no address at all reaches the page.
    expect(html).toContain("adopciones@refugio.example");
  });

  it("keeps the urgency note off an animal that does not carry the mark", async () => {
    await seedListedAnimal();
    expect(await (await get("/a/animal-1/canela")).text()).not.toContain(
      'data-testid="urgency"',
    );
  });

  it("prints the urgency reason, because a mark without one is not a mark", async () => {
    // `CONTEXT.md` builds the written reason into the definition of an Urgency, and the
    // prototype settled that the chip belongs on the card and the note belongs here.
    await seedListedAnimal({ urgentReason: "Tiene que salir del refugio esta semana." });
    expect(await (await get("/a/animal-1/canela")).text()).toContain(
      "Tiene que salir del refugio esta semana.",
    );
  });
});
