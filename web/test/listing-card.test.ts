import type { GoodWithFlags, ListedAnimal } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import {
  CARD_PHOTO_HEIGHT,
  CARD_PHOTO_WIDTH,
  cardModel,
  renderCard,
} from "../src/lib/listing/card.ts";

/**
 * The card's judgements, asserted as judgements. No DOM is involved and none is needed: what
 * #17 decided is *which lines appear with which emphasis*, and that is a pure function of an
 * index entry and the clock.
 */

const MEDIA = "https://media.pawster.test";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const ALL_YES: GoodWithFlags = { children: "Yes", dogs: "Yes", cats: "Yes" };
const ALL_UNKNOWN: GoodWithFlags = {
  children: "Unknown",
  dogs: "Unknown",
  cats: "Unknown",
};

function listed(overrides: Partial<ListedAnimal> = {}): ListedAnimal {
  return {
    id: "a1",
    name: "Canela",
    species: "dog",
    region: "Miranda",
    size: "Medium",
    sex: "Female",
    estimatedBirthDate: new Date("2023-01-01T00:00:00.000Z"),
    lastConfirmedAt: new Date("2026-09-07T00:00:00.000Z"),
    goodWith: { children: "Yes", dogs: "Yes", cats: "Unknown" },
    thumbnailKey: "d/abc.webp",
    bondedGroupId: null,
    urgent: false,
    shelterId: "s1",
    ...overrides,
  };
}

const card = (overrides: Partial<ListedAnimal> = {}, now: Date = NOW) =>
  cardModel(listed(overrides), now, MEDIA);

describe("the provenance line", () => {
  /**
   * The criterion, and the reason it is worded as *every* card: a line that appears only on
   * stale animals is a warning rather than information, and #17 measured the badge-only
   * treatment as *taller* than the honest line it was meant to be cheaper than.
   */
  it("is present on a fresh animal, in the same position and phrasing", () => {
    const fresh = card({ lastConfirmedAt: new Date("2026-09-07T00:00:00.000Z") });
    const stale = card({ lastConfirmedAt: new Date("2026-05-01T00:00:00.000Z") });

    expect(fresh.provenance).toBe("Miranda · Confirmada ayer");
    expect(stale.provenance).toBe("Miranda · Confirmada hace 4 meses");
  });

  it("agrees with the animal's sex", () => {
    expect(card({ sex: "Male" }).provenance).toBe("Miranda · Confirmado ayer");
    expect(card({ sex: "Female" }).provenance).toBe("Miranda · Confirmada ayer");
  });

  it("says today, yesterday and a count of days before it says months", () => {
    const at = (iso: string) => card({ lastConfirmedAt: new Date(iso) }).provenance;

    expect(at("2026-09-08T09:00:00.000Z")).toContain("hoy");
    expect(at("2026-09-07T00:00:00.000Z")).toContain("ayer");
    expect(at("2026-09-01T00:00:00.000Z")).toContain("hace 7 días");
    expect(at("2026-08-01T00:00:00.000Z")).toContain("hace un mes");
    expect(at("2026-03-01T00:00:00.000Z")).toContain("hace 6 meses");
  });

  /** Past 30 days the colour shifts, and nothing else about the card changes. */
  it("shifts colour past thirty days and not before", () => {
    const at = (iso: string) => card({ lastConfirmedAt: new Date(iso) });

    /** Thirty days exactly is still `Fresh`: the band's bound is inclusive. */
    expect(at("2026-08-09T12:00:00.000Z").provenanceAged).toBe(false);
    expect(at("2026-08-08T11:00:00.000Z").provenanceAged).toBe(true);
  });

  /**
   * The split #17 calls the actual resolution: the card states a fact, the page states the
   * consequence. `Puede que ya no esté disponible.` is the animal page's sentence and must
   * appear nowhere on a card, including the stalest one the platform can produce.
   */
  it("never carries the consequence sentence, however stale the animal", () => {
    const ancient = card({ lastConfirmedAt: new Date("2024-01-01T00:00:00.000Z") });

    expect(ancient.provenanceAged).toBe(true);
    expect(renderCard(ancient)).not.toContain("Puede que ya no esté");
    expect(renderCard(ancient)).not.toContain("disponible");
  });
});

describe("the good-with slot", () => {
  it("makes a known No a legible warning, one per axis", () => {
    const { goodWith: lines } = card({
      goodWith: { children: "Yes", dogs: "No", cats: "No" },
    });

    expect(lines.warnings).toEqual([
      "No convive con perros",
      "No convive con gatos",
    ]);
    expect(renderCard(card({ goodWith: { children: "Yes", dogs: "No", cats: "No" } })))
      .toContain("good-with-no");
  });

  it("merges the known Yeses into one quiet line", () => {
    expect(card({ goodWith: ALL_YES }).goodWith.positives).toBe(
      "Con niños, perros y gatos",
    );
    expect(
      card({ goodWith: { children: "Yes", dogs: "Unknown", cats: "Yes" } })
        .goodWith.positives,
    ).toBe("Con niños y gatos");
    expect(
      card({ goodWith: { children: "Unknown", dogs: "Unknown", cats: "Yes" } })
        .goodWith.positives,
    ).toBe("Con gatos");
  });

  /** One named line, not three chips — the +14%-scroll-to-say-less finding. */
  it("collapses the unknowns into one named line", () => {
    expect(
      card({ goodWith: { children: "Yes", dogs: "Unknown", cats: "Yes" } })
        .goodWith.unknown,
    ).toBe("Sin evaluar: perros");
    expect(
      card({ goodWith: { children: "Yes", dogs: "Unknown", cats: "Unknown" } })
        .goodWith.unknown,
    ).toBe("Sin evaluar: perros, gatos");
  });

  it("says it once for an animal nothing was assessed about", () => {
    const { goodWith: lines } = card({ goodWith: ALL_UNKNOWN });

    expect(lines.unknown).toBe("Convivencia sin evaluar");
    expect(lines.positives).toBeNull();
    expect(lines.warnings).toEqual([]);
  });

  it("has nothing to say when every axis is a known Yes", () => {
    expect(card({ goodWith: ALL_YES }).goodWith.unknown).toBeNull();
  });

  /**
   * **The slot's worst case is three lines, not two**, and the stylesheet reserves three
   * because of this test. #17 specifies "a fixed two-line reservation … enough for the worst
   * case in the seed data: two `No`s plus a `Yes`" — which is three phrases under its own
   * three-weights rule, since only the positives merge and only the unknowns collapse.
   *
   * The animal that made this matter is ordinary rather than contrived: children `No`, dogs
   * `Yes`, cats `Unknown` produced three lines into a two-line slot, and what fell off the
   * bottom was `Sin evaluar: gatos` — the label `CONTEXT.md` requires an unassessed axis to
   * carry.
   */
  it("emits at most three lines, and three is reached by ordinary animals", () => {
    const lineCount = (flags: GoodWithFlags): number => {
      const { goodWith: lines } = card({ goodWith: flags });
      return (
        lines.warnings.length +
        (lines.positives === null ? 0 : 1) +
        (lines.unknown === null ? 0 : 1)
      );
    };

    expect(lineCount({ children: "No", dogs: "Yes", cats: "Unknown" })).toBe(3);
    expect(lineCount({ children: "No", dogs: "No", cats: "Yes" })).toBe(3);
    expect(lineCount({ children: "No", dogs: "No", cats: "No" })).toBe(3);
    expect(lineCount(ALL_UNKNOWN)).toBe(1);
    expect(lineCount(ALL_YES)).toBe(1);

    /** Every combination there is, so "at most three" is exhaustive rather than sampled. */
    const flags: GoodWithFlags["children"][] = ["Yes", "No", "Unknown"];
    for (const children of flags) {
      for (const dogs of flags) {
        for (const cats of flags) {
          expect(lineCount({ children, dogs, cats })).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe("the meta line", () => {
  it("composes species and band, and never double-names a puppy", () => {
    const puppy = card({
      species: "dog",
      sex: "Female",
      estimatedBirthDate: new Date("2026-06-01T00:00:00.000Z"),
    });
    const kitten = card({
      species: "cat",
      size: null,
      sex: "Female",
      estimatedBirthDate: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(puppy.meta).toBe("Cachorra · Mediana");
    expect(kitten.meta).toBe("Gatica");
    expect(kitten.meta).not.toContain("Gata gatica");
  });

  it("reads adult dog and adult cat the way Spanish orders them", () => {
    expect(card({ estimatedBirthDate: new Date("2020-01-01T00:00:00.000Z") }).meta).toBe(
      "Perra adulta · Mediana",
    );
    expect(
      card({
        species: "cat",
        size: null,
        sex: "Male",
        estimatedBirthDate: new Date("2020-01-01T00:00:00.000Z"),
      }).meta,
    ).toBe("Gato adulto");
  });

  /** ADR 0018's disclosure, once for the whole card and not once per bent word. */
  it("discloses an unrecorded sex exactly once", () => {
    const meta = card({
      sex: "Unknown",
      estimatedBirthDate: new Date("2020-01-01T00:00:00.000Z"),
    }).meta;

    expect(meta).toBe("Perro adulto · Mediano · sexo no registrado");
    expect(meta.match(/sexo no registrado/g)).toHaveLength(1);
  });

  it("omits size for a cat, because the absence is the animal's shape", () => {
    expect(card({ species: "cat", size: null }).meta).not.toContain("·");
  });

  /**
   * The band is derived at render time from the date the index carries, which is why the same
   * bytes describe the animal correctly later. A stored band would freeze here.
   */
  it("re-bands the same animal as the clock moves", () => {
    const born = new Date("2026-06-01T00:00:00.000Z");

    expect(card({ estimatedBirthDate: born }, NOW).meta).toContain("Cachorra");
    expect(
      card({ estimatedBirthDate: born }, new Date("2028-09-08T00:00:00.000Z")).meta,
    ).toContain("Perra joven");
  });
});

describe("the urgency chip", () => {
  it("renders as a chip beside the name, not as a banner", () => {
    const html = renderCard(card({ urgent: true }));

    expect(html).toContain('data-testid="urgent-chip"');
    expect(html).toContain("Urgente");
  });

  it("is absent, and says nothing, on an animal without the mark", () => {
    expect(renderCard(card())).not.toContain("urgent-chip");
  });

  /** The written reason lives on the animal page; the index does not even carry it. */
  it("puts no reason on the card", () => {
    expect(renderCard(card({ urgent: true }))).not.toMatch(/Urgente:/);
  });
});

describe("the photo box", () => {
  it("carries width and height attributes, which is what reserves it", () => {
    const html = renderCard(card());

    expect(html).toContain(`width="${CARD_PHOTO_WIDTH}"`);
    expect(html).toContain(`height="${CARD_PHOTO_HEIGHT}"`);
  });

  /**
   * The attributes are the *box* and not the bytes, so every card reserves the same height
   * whatever shape the derivative behind it turns out to be — which is what a fixed-height
   * card in a two-up grid requires, given `cardThumbnail` is `scale-down` and therefore
   * aspect-preserving.
   */
  it("reserves the same box for every animal", () => {
    const one = card({ id: "a1" });
    const two = card({ id: "a2", name: "Simón", region: "Zulia" });

    expect(one.photo.width).toBe(two.photo.width);
    expect(one.photo.height).toBe(two.photo.height);
  });

  it("points at the bucket's public base and the index's own key", () => {
    expect(card({ thumbnailKey: "d/deadbeef.webp" }).photo.src).toBe(
      "https://media.pawster.test/d/deadbeef.webp",
    );
  });

  it("defers the bytes, because photo payload is the listing's real constraint", () => {
    expect(renderCard(card())).toContain('loading="lazy"');
  });
});

describe("what the markup does with shelter-authored text", () => {
  /**
   * Names and regions are written by shelters and arrive over the network inside the index, so
   * they are untrusted input being interpolated into a document.
   */
  it("escapes a name that would otherwise be markup", () => {
    const html = renderCard(card({ name: '<img src=x onerror="alert(1)">' }));

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  /**
   * Both quote forms, even though every attribute written here is double-quoted: the day
   * somebody writes one with single quotes, nothing would complain.
   */
  it("escapes both quote forms in a name", () => {
    const html = renderCard(card({ name: `Coco "el gato" d'Aragua` }));

    expect(html).toContain("&quot;el gato&quot;");
    expect(html).toContain("d&#39;Aragua");
  });

  it("escapes an ampersand in a region without double-escaping it", () => {
    const html = renderCard(card({ region: "Bolívar & Sucre" }));

    expect(html).toContain("Bolívar &amp; Sucre");
    expect(html).not.toContain("&amp;amp;");
  });
});

describe("the card as a whole", () => {
  it("links to the animal's own page by its id", () => {
    expect(card({ id: "m6p2" }).href).toBe("/animales/m6p2");
  });

  /**
   * The committed field set, stated as an assertion. #17: making the grid uniform means
   * committing to a fixed field set, "enforced by the layout rather than chosen" — and the
   * two deliberate exclusions are the shelter's name and sterilisation.
   */
  it("names no shelter and no sterilisation", () => {
    const html = renderCard(card({ shelterId: "refugio-los-teques" }));

    expect(html).not.toContain("refugio-los-teques");
    expect(html).not.toContain("Esterilizada");
    expect(html).not.toContain("Sin esterilizar");
  });
});
