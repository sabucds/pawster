import type { AgeBand, Sex, Species } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import {
  AGE_BAND_WORDS,
  SEX_UNKNOWN_NOTE,
  ageBandLabel,
  agree,
  describeAnimal,
  goodWithPhrase,
  sentence,
  speciesAndBand,
} from "../src/lib/animals/words.ts";

/**
 * The es-VE words, as a table.
 *
 * [ADR 0018](../../docs/adr/0018-strings-are-typed-phrase-functions.md) asks for exactly this and
 * names the rows: "`Gata gatica` is a table row, as is `Gatico` against `Gatito`, as is the
 * `"Unknown"` masculine fallback carrying `sexo no registrado`." Each one is a phrase that
 * renders, type-checks and is *wrong* — the failure mode the ADR exists to design out — so a
 * type cannot catch any of them and only a table can.
 *
 * Plain Node: a phrase function is `(facts) => string`, so there is no Worker, no DOM and no
 * clock in the seam.
 */

describe("agree", () => {
  const word = { m: "Perro", f: "Perra" };

  it("takes the feminine for a female, and reports the gender as known", () => {
    expect(agree(word, "Female")).toEqual({ word: "Perra", assumed: false });
  });

  it("takes the masculine for a male, and reports the gender as known", () => {
    expect(agree(word, "Male")).toEqual({ word: "Perro", assumed: false });
  });

  it("falls back to the masculine for an unrecorded sex, and says it assumed", () => {
    /**
     * Spanish's unmarked form is masculine, so there is no third form to reach for. The `assumed`
     * bit is the whole mechanism: a bare `Perro` for an animal nobody recorded reads as a claim,
     * and returning the fact rather than discarding it is what lets `sentence` disclose it.
     */
    expect(agree(word, "Unknown")).toEqual({ word: "Perro", assumed: true });
  });
});

describe("sentence", () => {
  it("joins the parts and appends nothing when every gender was known", () => {
    const parts = [
      { word: "Perra joven", assumed: false },
      { word: "Mediana", assumed: false },
    ];
    expect(sentence(parts)).toBe("Perra joven · Mediana");
  });

  it("appends the note once, however many parts assumed", () => {
    // The reader is being told one fact about the animal, not one per bent word.
    const parts = [
      { word: "Perro", assumed: true },
      { word: "Mediano", assumed: true },
      { word: "Esterilizado", assumed: true },
    ];
    expect(sentence(parts)).toBe(
      `Perro · Mediano · Esterilizado · ${SEX_UNKNOWN_NOTE}`,
    );
  });

  it("appends the note when only one part assumed", () => {
    const parts = [
      { word: "Grande", assumed: false },
      { word: "Perro", assumed: true },
    ];
    expect(sentence(parts)).toContain(SEX_UNKNOWN_NOTE);
  });
});

describe("speciesAndBand", () => {
  /**
   * The rule: for the first band only, the band word **replaces** the species word, because
   * `Cachorra` and `Gatica` each name a species as well as a stage of life. Composing them the
   * way every other band composes is what produced `Gata gatica` on the first prototype render.
   */
  const cases: ReadonlyArray<{
    species: Species;
    band: AgeBand;
    sex: Sex;
    expected: string;
  }> = [
    { species: "dog", band: "Puppy", sex: "Female", expected: "Cachorra" },
    { species: "dog", band: "Puppy", sex: "Male", expected: "Cachorro" },
    { species: "cat", band: "Kitten", sex: "Female", expected: "Gatica" },
    { species: "cat", band: "Kitten", sex: "Male", expected: "Gatico" },
    { species: "dog", band: "Young", sex: "Female", expected: "Perra joven" },
    { species: "dog", band: "Adult", sex: "Female", expected: "Perra adulta" },
    { species: "dog", band: "Adult", sex: "Male", expected: "Perro adulto" },
    { species: "dog", band: "Senior", sex: "Male", expected: "Perro senior" },
    { species: "cat", band: "Young", sex: "Male", expected: "Gato joven" },
    { species: "cat", band: "Adult", sex: "Female", expected: "Gata adulta" },
    { species: "cat", band: "Senior", sex: "Female", expected: "Gata senior" },
  ];

  for (const { species, band, sex, expected } of cases) {
    it(`renders ${species}/${band}/${sex} as ${expected}`, () => {
      expect(speciesAndBand(species, band, sex).word).toBe(expected);
    });
  }

  it("never double-names the animal on a first band", () => {
    // `Gata gatica`, the exact render that prompted ADR 0018.
    expect(speciesAndBand("cat", "Kitten", "Female").word).not.toContain("Gata ");
    expect(speciesAndBand("dog", "Puppy", "Female").word).not.toContain("Perra ");
  });

  it("spells the cat's first band with -ico, not -ito", () => {
    /**
     * es-VE takes `-ico` after a `t` stem (`gato → gatico`, as `rato → ratico`), so `gatica`
     * implies `gatico`. ADR 0018 corrects the prototype's `Gatito` here.
     */
    expect(AGE_BAND_WORDS.Kitten).toEqual({ m: "Gatico", f: "Gatica" });
    expect(speciesAndBand("cat", "Kitten", "Male").word).not.toContain("Gatito");
  });

  it("discloses an assumed gender through the phrase it built", () => {
    expect(speciesAndBand("dog", "Adult", "Unknown").assumed).toBe(true);
    expect(speciesAndBand("dog", "Adult", "Female").assumed).toBe(false);
  });
});

describe("ageBandLabel", () => {
  it("capitalises a band standing on its own", () => {
    // `Joven` opens a value in a definition list; `joven` only trails a noun.
    expect(ageBandLabel("Young", "Female")).toBe("Joven");
    expect(ageBandLabel("Adult", "Female")).toBe("Adulta");
    expect(ageBandLabel("Adult", "Male")).toBe("Adulto");
    expect(ageBandLabel("Senior", "Male")).toBe("Senior");
  });

  it("keeps the first bands' own nouns", () => {
    expect(ageBandLabel("Puppy", "Female")).toBe("Cachorra");
    expect(ageBandLabel("Kitten", "Male")).toBe("Gatico");
  });

  it("never renders the domain value for a band that has a Spanish word", () => {
    /**
     * The regression this guards: `Etapa: Young` on an es-VE page, which is what rendering
     * `deriveAgeBand()`'s return value directly produced.
     *
     * `Senior` is excluded because it is genuinely the same word in both languages — it is one of
     * the six pairs ADR 0018 counts as having identical members, so an assertion that the Spanish
     * differs from the English would be asserting a mistranslation.
     */
    const bands: readonly AgeBand[] = ["Puppy", "Kitten", "Young", "Adult"];
    for (const band of bands) {
      for (const sex of ["Male", "Female", "Unknown"] as const) {
        expect(ageBandLabel(band, sex), `${band}/${sex}`).not.toBe(band);
      }
    }
  });
});

describe("goodWithPhrase", () => {
  it("renders each answer as a whole phrase, not a joined word", () => {
    expect(goodWithPhrase("cats", "No")).toBe("No convive con gatos");
    expect(goodWithPhrase("dogs", "Unknown")).toBe("Sin evaluar: perros");
    expect(goodWithPhrase("children", "Yes")).toBe("Convive con niños");
  });

  it("agrees with the other animals rather than with this one", () => {
    // There is no sex parameter, and that is the decision: the phrase is about who the animal
    // lives with, so nothing here inflects for the animal itself.
    expect(goodWithPhrase("cats", "Yes")).toBe("Convive con gatos");
  });
});

describe("describeAnimal", () => {
  const female = {
    species: "dog",
    sex: "Female",
    size: "Medium",
    sterilisation: "Sterilised",
  } as const;

  it("composes band, size and sterilisation, all agreed", () => {
    expect(describeAnimal(female, "Adult")).toBe(
      "Perra adulta · Mediana · Esterilizada",
    );
  });

  it("lets the first band replace the species word", () => {
    expect(describeAnimal(female, "Puppy")).toBe(
      "Cachorra · Mediana · Esterilizada",
    );
  });

  it("omits the size for a cat, whose shape has none", () => {
    const cat = {
      species: "cat",
      sex: "Male",
      size: null,
      sterilisation: "Unknown",
    } as const;
    // The absence is the animal's shape, not a gap in what the shelter typed.
    expect(describeAnimal(cat, "Adult")).toBe("Gato adulto · No se sabe");
  });

  it("discloses an unrecorded sex exactly once", () => {
    const unknown = { ...female, sex: "Unknown" } as const;
    const line = describeAnimal(unknown, "Adult");

    expect(line).toBe(
      `Perro adulto · Mediano · Esterilizado · ${SEX_UNKNOWN_NOTE}`,
    );
    expect(line.match(new RegExp(SEX_UNKNOWN_NOTE, "g"))).toHaveLength(1);
  });
});
