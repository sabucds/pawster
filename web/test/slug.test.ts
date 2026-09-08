import { describe, expect, it } from "vitest";
import { isReservedSlug, slugCandidates, slugify } from "../src/lib/slug.ts";

/**
 * The slug is generated once per shelter and never rewritten, so this function runs about
 * forty times in the platform's life and every result is a permanent address. That is why
 * a table test is worth more here than the line count suggests.
 */

describe("slugify", () => {
  it.each([
    ["Refugio Los Teques", "refugio-los-teques"],
    // The accent cases, which are the reason NFD decomposition is used rather than a
    // character map: every one of these works without a table entry of its own.
    ["Fundación Protectora", "fundacion-protectora"],
    ["Refugio Añañá", "refugio-anana"],
    ["Albergue Camagüey", "albergue-camaguey"],
    ["Patitas Félices", "patitas-felices"],
    // Punctuation, symbols and runs of whitespace all collapse to single separators.
    ["Huellitas & Colas", "huellitas-colas"],
    ["  Refugio   Doble  ", "refugio-doble"],
    ["¡Adopta Ya!", "adopta-ya"],
    ["Refugio #1", "refugio-1"],
    ["S.O.S. Animales", "s-o-s-animales"],
    // Leading and trailing separators are trimmed rather than left as hyphens.
    ["---Refugio---", "refugio"],
  ])("turns %o into %o", (displayName, expected) => {
    expect(slugify(displayName)).toBe(expected);
  });

  it("falls back to a stem for a name that transliterates to nothing", () => {
    // Rare to the point of hypothetical, and it still needs an answer: the alternative is a
    // registration that fails on a name the shelter is entitled to use.
    expect(slugify("🐶🐱")).toBe("refugio");
    expect(slugify("...")).toBe("refugio");
  });

  it("truncates at a word boundary rather than mid-word", () => {
    const long = "Fundación Protectora de Animales Abandonados del Estado Miranda y Aragua";
    const slug = slugify(long);

    expect(slug.length).toBeLessThanOrEqual(60);
    // A slug cut to `...miran` reads as a typo; cut to `...estado` it reads as a name.
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("fundacion-protectora-de-animales-abandonados-del-estado");
  });

  it("hard-cuts a single word longer than the limit, having no boundary to prefer", () => {
    expect(slugify("A".repeat(80))).toBe("a".repeat(60));
  });
});

describe("slugCandidates", () => {
  it("offers the bare stem first", () => {
    const [first] = slugCandidates("Refugio Los Teques");
    expect(first).toBe("refugio-los-teques");
  });

  it("numbers collisions from two, because -1 implies a -0 that does not exist", () => {
    const candidates = slugCandidates("Refugio Los Teques");
    expect([candidates.next().value, candidates.next().value, candidates.next().value]).toEqual([
      "refugio-los-teques",
      "refugio-los-teques-2",
      "refugio-los-teques-3",
    ]);
  });

  it("never offers a reserved slug as the whole slug", () => {
    /**
     * The case this list exists for. `/refugios/registro` and `/refugios/entrar` are real
     * paths under the same prefix a shelter's own page lives at, so a shelter calling itself
     * "Registro" would otherwise be handed an address the platform had already spent.
     *
     * Note it is still a perfectly good *stem* — the numbered form is offered instead of the
     * name being rejected, because the shelter has done nothing wrong.
     */
    const candidates = slugCandidates("Registro");
    expect(candidates.next().value).toBe("registro-2");
  });

  it("reserves every path segment that exists under /refugios today", () => {
    // The assertion that keeps the list honest as routes are added: each of these is a real
    // file in `src/pages/refugios/`, and a shelter must not be able to shadow one.
    for (const segment of ["registro", "entrar", "panel"]) {
      expect(isReservedSlug(segment)).toBe(true);
    }
  });
});
