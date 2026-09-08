import type { GoodWithFlags, ListedAnimal } from "@pawster/domain";
import { parseIndex, selectListed, serializeIndex } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { cardModel, renderCard } from "../src/lib/listing/card.ts";
import {
  criteriaFromSearch,
  searchFromCriteria,
} from "../src/lib/listing/criteria.ts";
import { regionsIn, statusLine } from "../src/lib/listing/island.ts";

/**
 * Filtering, end to end, minus the document.
 *
 * The island's change handler does exactly this: read the panel into a criteria, hand the
 * criteria and the parsed index to `selectListed`, build a card per survivor, and write a
 * status line. Every one of those is a pure function, so the whole path can be driven here —
 * which is what lets the "zero network requests" criterion below be an assertion rather than
 * a claim about code nobody executes in a test.
 */

const MEDIA = "https://media.pawster.test";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const UNKNOWN: GoodWithFlags = {
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
    goodWith: UNKNOWN,
    thumbnailKey: "d/abc.webp",
    bondedGroupId: null,
    urgent: false,
    shelterId: "s1",
    ...overrides,
  };
}

/** A catalogue that varies on every axis at once, written and read back as real index bytes. */
const CATALOGUE: readonly ListedAnimal[] = parseIndex(
  serializeIndex({
    generatedAt: "2026-09-08",
    animals: [
      listed({
        id: "aragua-dog",
        name: "Negrita",
        region: "Aragua",
        lastConfirmedAt: new Date("2026-09-06T00:00:00.000Z"),
      }),
      listed({
        id: "carabobo-cat",
        name: "Pelusa",
        region: "Carabobo",
        species: "cat",
        size: null,
        lastConfirmedAt: new Date("2026-09-05T00:00:00.000Z"),
      }),
      listed({
        id: "zulia-no-cats",
        name: "Manchas",
        region: "Zulia",
        goodWith: { children: "Yes", dogs: "Yes", cats: "No" },
        lastConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      listed({
        id: "miranda-fresh",
        name: "Canela",
        region: "Miranda",
        urgent: true,
        lastConfirmedAt: new Date("2026-09-08T06:00:00.000Z"),
      }),
    ],
  }),
).animals;

/** The island's render, without the DOM writes. */
function renderFor(search: string) {
  const criteria = criteriaFromSearch(search);
  const shown = selectListed(CATALOGUE, criteria, NOW);
  return {
    ids: shown.map((animal) => animal.id),
    html: shown.map((animal) => renderCard(cardModel(animal, NOW, MEDIA))).join(""),
    status: statusLine(shown.length, CATALOGUE.length),
  };
}

describe("filtering after the first load", () => {
  /**
   * The criterion, and the interceptor is what makes it real: `test/setup.ts` installs it for
   * every test in this project and `afterEach` fails the test on any call to an unregistered
   * host — so a filter path that reached the network would fail here rather than pass quietly.
   * The explicit assertion on the call log covers the other half: a call to a *registered*
   * vendor would not be a violation, and would still be a request this page must not make.
   */
  it("issues no network request, across all six axes", () => {
    for (const search of [
      "?species=dog",
      "?regions=Aragua&regions=Carabobo",
      "?sizes=Medium",
      "?sexes=Female",
      "?ageBands=Young",
      "?goodWith=cats",
      "?species=dog&regions=Miranda&sizes=Medium&sexes=Female&ageBands=Young&goodWith=children",
    ]) {
      renderFor(search);
    }

    expect(outbound.calls).toHaveLength(0);
  });

  it("shows everything, freshest-confirmed first, with no filters at all", () => {
    expect(renderFor("").ids).toEqual([
      "miranda-fresh",
      "aragua-dog",
      "carabobo-cat",
      "zulia-no-cats",
    ]);
  });

  /** "Carabobo or Aragua, I'll drive" is one criteria, one URL and one filter. */
  it("accepts several regions at once", () => {
    expect(renderFor("?regions=Aragua&regions=Carabobo").ids).toEqual([
      "aragua-dog",
      "carabobo-cat",
    ]);
  });

  it("excludes only a known No on a good-with axis, and labels the unknowns it keeps", () => {
    const { ids, html } = renderFor("?goodWith=cats");

    expect(ids).not.toContain("zulia-no-cats");
    expect(ids).toContain("miranda-fresh");
    /** The animals that survived were kept *because* unknown is not exclusion — say so. */
    expect(html).toContain("Convivencia sin evaluar");
  });

  it("keeps a cat out of a size filter rather than passing it vacuously", () => {
    expect(renderFor("?sizes=Medium").ids).not.toContain("carabobo-cat");
  });

  it("orders the same whether or not an urgent animal is in the results", () => {
    const withUrgent = renderFor("?regions=Miranda&regions=Aragua").ids;

    expect(withUrgent).toEqual(["miranda-fresh", "aragua-dog"]);
  });

  it("leaves nothing when the filters exclude everything, and says what to do", () => {
    const { ids, status } = renderFor("?species=cat&sizes=Giant");

    expect(ids).toEqual([]);
    expect(status).toContain("Quita alguno");
  });
});

describe("the panel's state as a URL", () => {
  it("round-trips a criteria through the query string", () => {
    const search = "?species=dog&regions=aragua&regions=carabobo&goodWith=cats";

    expect(searchFromCriteria(criteriaFromSearch(search))).toBe(search);
  });

  /**
   * Canonical, and for regions that means normalised as well as ordered: `domain/`'s parser
   * lower-cases a region because it is an identifier, so a link built from a typed-out
   * `Aragua` and one built from a ticked checkbox are the same link.
   */
  it("is canonical, so two adopters who ticked the same boxes get the same link", () => {
    const one = criteriaFromSearch("?regions=Carabobo&regions=Aragua&species=dog");
    const two = criteriaFromSearch("?species=dog&regions=aragua&regions=CARABOBO");

    expect(searchFromCriteria(one)).toBe(searchFromCriteria(two));
    expect(searchFromCriteria(one)).toBe(
      "?species=dog&regions=aragua&regions=carabobo",
    );
  });

  it("drops a value that is not on its axis, rather than filtering by it", () => {
    const criteria = criteriaFromSearch("?species=hamster&sizes=Enormous&sexes=Female");

    expect(criteria.species).toBeUndefined();
    expect(criteria.sizes).toBeUndefined();
    expect(criteria.sexes).toEqual(["Female"]);
  });

  /**
   * A hand-edited query with junk on every closed axis must leave a criteria that constrains
   * nothing — an empty criteria means "everything" — rather than one that quietly shows an
   * adopter nothing at all.
   */
  it("falls back to the whole listing when every value is junk", () => {
    expect(renderFor("?species=hamster&sizes=Enormous").ids).toHaveLength(
      CATALOGUE.length,
    );
  });

  /**
   * Nothing can check that a region exists — ADR 0005 makes the vocabulary per-country
   * reference data — so it is kept as an identifier and a typo matches no animal rather than
   * failing. Lower-cased, because that is what makes it comparable with an animal's.
   */
  it("keeps a region it cannot possibly validate, as an identifier", () => {
    expect(criteriaFromSearch("?regions=Nueva%20Esparta").regions).toEqual([
      "nueva esparta",
    ]);
  });

  it("gives the unfiltered listing the page's own address", () => {
    expect(searchFromCriteria({})).toBe("");
    expect(searchFromCriteria(criteriaFromSearch(""))).toBe("");
  });
});

describe("the regions offered", () => {
  /**
   * Taken from the index because there is no region reference data yet (ADR 0005 makes it a
   * country's administrative divisions, owned by a later ticket). A checkbox for a state with
   * nothing in it is a filter that can only ever empty the page.
   */
  it("is the distinct regions that actually have animals, in Spanish order", () => {
    expect(regionsIn(CATALOGUE)).toEqual([
      "Aragua",
      "Carabobo",
      "Miranda",
      "Zulia",
    ]);
  });

  it("offers each region once however many animals are in it", () => {
    const animals = [
      listed({ id: "a", region: "Miranda" }),
      listed({ id: "b", region: "Miranda" }),
      listed({ id: "c", region: "Anzoátegui" }),
    ];

    expect(regionsIn(animals)).toEqual(["Anzoátegui", "Miranda"]);
  });

  it("offers none at all for an empty catalogue", () => {
    expect(regionsIn([])).toEqual([]);
  });
});

describe("the status line", () => {
  it("agrees with the number in front of it", () => {
    expect(statusLine(1, 1)).toBe("1 animal");
    expect(statusLine(4, 4)).toBe("4 animales");
    expect(statusLine(1, 9)).toBe("1 animal de 9");
    expect(statusLine(3, 9)).toBe("3 animales de 9");
  });

  /** An empty platform and an over-filtered one are different problems and read differently. */
  it("distinguishes an empty platform from filters that exclude everything", () => {
    expect(statusLine(0, 0)).toContain("Todavía no hay animales");
    expect(statusLine(0, 12)).toContain("Quita alguno");
  });
});
