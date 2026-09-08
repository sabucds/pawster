import type { AgeBand, Sex, Species } from "@pawster/domain";
import { describe, expect, it } from "vitest";
import type { AnimalWords } from "../src/lib/animals/words.ts";
import {
  AGE_BAND_WORDS,
  AGE_BASIS_NOTES,
  ARCHIVE_ELSEWHERE,
  ARCHIVE_EXPLANATIONS,
  ARCHIVE_HEADLINES,
  MAYBE_GONE,
  SEX_UNKNOWN_NOTE,
  ageBandLabel,
  ageText,
  ageWithBasis,
  agoPhrase,
  agree,
  archiveExplanation,
  archiveHeadline,
  confirmationSentence,
  confirmedAgo,
  describeAnimal,
  goodWithPhrase,
  metaLine,
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

/**
 * The animal page's own phrases (issue #57): the provenance line, the age's basis, and the
 * words an archive page finds for what happened.
 *
 * Same seam as everything above — no clock of its own. Every function takes `asOf`, so the
 * table below is a table rather than something that re-bands itself next Tuesday.
 */

const NOW = new Date("2026-09-08T12:00:00Z");

describe("agoPhrase", () => {
  it("coarsens the unit as the number grows, because that is how it is read", () => {
    // `hace 47 días` is arithmetic the reader has to do; `hace 7 semanas` is a fact.
    expect(agoPhrase(0)).toBe("hoy");
    expect(agoPhrase(1)).toBe("ayer");
    expect(agoPhrase(3)).toBe("hace 3 días");
    expect(agoPhrase(7)).toBe("hace 1 semana");
    expect(agoPhrase(20)).toBe("hace 3 semanas");
    expect(agoPhrase(35)).toBe("hace 1 mes");
    expect(agoPhrase(120)).toBe("hace 4 meses");
  });

  it("reads a confirmation dated in the future as today rather than throwing", () => {
    // Clock skew, or a shelter's device. Refusing to render the page is worse than rendering
    // the kindest answer — the same forgiveness `deriveStalenessBand` extends.
    expect(agoPhrase(-5)).toBe("hoy");
  });
});

describe("the fact and the consequence are two functions", () => {
  it("gives the listing card a line with no consequence in it", () => {
    /**
     * The acceptance criterion is a *split* — "the consequence sentence appears on the page and
     * nowhere on the listing card" — so the split has to be expressible in the API, not just
     * observed at one call site. Issue #56 renders `Miranda · Confirmada ayer` from this
     * function, and it cannot reach the consequence from here.
     */
    const card = confirmedAgo("Female", new Date("2026-05-08T12:00:00Z"), NOW);

    expect(card).toBe("Confirmada hace 4 meses");
    expect(card).not.toContain(MAYBE_GONE);
    // Nor the shelter: on a card of twelve animals, every line would say `por el refugio`.
    expect(card).not.toContain("refugio");
  });

  it("builds the page's line out of the card's, so the two cannot disagree", () => {
    const page = confirmationSentence("Female", new Date("2026-05-08T12:00:00Z"), NOW);
    expect(page.startsWith(confirmedAgo("Female", new Date("2026-05-08T12:00:00Z"), NOW))).toBe(
      true,
    );
  });
});

describe("the provenance line", () => {
  it("agrees with the animal and names whose word it is", () => {
    const line = confirmationSentence("Female", new Date("2026-05-08T12:00:00Z"), NOW);

    expect(line).toContain("Confirmada");
    expect(line).toContain("hace 4 meses");
    // Without this the line reads as Pawster's own assurance, and the platform has verified
    // nothing about this animal.
    expect(line).toContain("por el refugio");
  });

  it("takes the masculine for an animal whose sex was never recorded", () => {
    expect(
      confirmationSentence("Unknown", new Date("2026-09-07T12:00:00Z"), NOW),
    ).toContain("Confirmado");
  });

  it("states the consequence even for an animal confirmed yesterday", () => {
    /**
     * The divergence from the prototype, asserted so it cannot be quietly undone. Pawster does
     * not know whether an animal confirmed yesterday is still there — no shelter has told it
     * anything since — so the sentence is as true at one day as at four months, and printing it
     * only once the platform has grown nervous makes its *presence* the warning. That is the
     * exact failure the prototype named and then resolved for the card alone.
     */
    const fresh = confirmationSentence("Female", new Date("2026-09-07T12:00:00Z"), NOW);
    const stale = confirmationSentence("Female", new Date("2026-01-08T12:00:00Z"), NOW);

    expect(fresh).toBe("Confirmada ayer por el refugio. Puede que ya no esté disponible.");
    expect(stale).toContain(MAYBE_GONE);
  });
});

describe("the age and its basis", () => {
  it("hedges every basis but a documented one", () => {
    /**
     * The acceptance criterion in one word. A shelter that ticked `ShelterGuess` said it was
     * guessing, and `3 años` renders that guess as a fact about the animal.
     */
    const birth = new Date("2023-09-08T12:00:00Z");

    expect(ageText(birth, "ShelterGuess", NOW)).toBe("unos 3 años");
    expect(ageText(birth, "VetEstimate", NOW)).toBe("unos 3 años");
    expect(ageText(birth, "Documented", NOW)).toBe("3 años");
  });

  it("counts in months below eighteen and in years above", () => {
    // `unos 26 meses` is a number nobody says.
    expect(ageText(new Date("2025-11-08T12:00:00Z"), "ShelterGuess", NOW)).toBe(
      "unos 10 meses",
    );
    expect(ageText(new Date("2025-04-08T12:00:00Z"), "ShelterGuess", NOW)).toBe(
      "unos 17 meses",
    );
    expect(ageText(new Date("2025-03-08T12:00:00Z"), "ShelterGuess", NOW)).toBe(
      "unos 2 años",
    );
  });

  it("never says zero months, because a zero reads as missing data", () => {
    expect(ageText(new Date("2026-09-01T12:00:00Z"), "ShelterGuess", NOW)).toBe(
      "unos 1 mes",
    );
  });

  it("says who did the estimating, and agrees with la edad rather than the animal", () => {
    /**
     * Every one of these is `estimada`, feminine, whatever the animal is — they modify `la
     * edad`. That is also the tell that this table is genuinely a second one rather than a
     * duplicate of the form's `AGE_BASIS_LABELS`, which answers `¿Cómo saben la edad?` in the
     * second person.
     */
    expect(ageWithBasis(new Date("2023-09-08T12:00:00Z"), "ShelterGuess", NOW)).toBe(
      "unos 3 años (estimada por el refugio)",
    );
    expect(AGE_BASIS_NOTES.VetEstimate).toBe("estimada por veterinario");
    expect(AGE_BASIS_NOTES.Documented).toBe("según documentos");
  });
});

describe("what an archive page says happened", () => {
  it("gives an adopted animal a headline of its own", () => {
    // The outcome the platform exists to produce, and the difference between a dead link and a
    // good ending for an adopter who arrived late at a forwarded message.
    expect(archiveHeadline("Adopted", "Female")).toBe("Encontró casa");
    expect(archiveHeadline("NoLongerAvailable", "Female")).toBe(
      "Ya no está disponible",
    );
  });

  it("claims nothing about an animal whose shelter merely left", () => {
    /**
     * Nobody said anything about *her*: she may well still be looking for a home. What ended is
     * Pawster's ability to put an adopter in touch, which is a fact about the platform and the
     * shelter — and a headline saying she is unavailable would assert something no one told us,
     * on the one page whose whole purpose is to say only what is known.
     */
    for (const reason of ["ShelterDeparted", "ShelterUnreachable"] as const) {
      expect(archiveHeadline(reason, "Female")).toBe(
        "Ya no podemos ponerte en contacto",
      );
      expect(archiveHeadline(reason, "Female")).not.toContain("disponible");
    }
  });

  it("words the four reasons apart in the explanation", () => {
    const explanations = (["Adopted", "NoLongerAvailable", "ShelterDeparted", "ShelterUnreachable"] as const).map(
      (reason) => archiveExplanation(reason, "Female"),
    );

    expect(new Set(explanations).size).toBe(4);
  });

  it("attributes an adoption to the shelter rather than claiming it", () => {
    // `El refugio dice` does the work `por el refugio` does in the provenance line: Pawster
    // witnessed no adoption, and it must not sound as though it did.
    expect(archiveExplanation("Adopted", "Female")).toContain("El refugio dice");
  });

  it("agrees an adoption with the animal's sex", () => {
    expect(archiveExplanation("Adopted", "Female")).toContain("adoptada");
    expect(archiveExplanation("Adopted", "Male")).toContain("adoptado");
  });

  it("never names the concept to the adopter", () => {
    /**
     * `CONTEXT.md` left the *Archive* row unsettled for the issue that built this page, and it
     * settles as *(no noun)*: an adopter did not come to read a filing status, so the page
     * states the event and the word `archivo` appears nowhere.
     */
    const everything = [
      ...Object.values(ARCHIVE_HEADLINES),
      ...Object.values(ARCHIVE_EXPLANATIONS),
      { m: ARCHIVE_ELSEWHERE, f: ARCHIVE_ELSEWHERE },
    ].flatMap((pair) => [pair.m, pair.f]);

    for (const phrase of everything) {
      expect(phrase.toLowerCase()).not.toContain("archiv");
    }
  });
});

describe("metaLine", () => {
  const female: AnimalWords = {
    species: "dog",
    sex: "Female",
    size: "Medium",
    sterilisation: "Sterilised",
  };

  it("stops before sterilisation, which the facts table under it already says", () => {
    /**
     * The prototype's rule: "the page's facts table also drops what the heading already says".
     * A heading reading `Perra joven · Mediana · Esterilizada` above a row saying
     * `Esterilización: Esterilizada` is a duplication, and the animal page renders both.
     */
    expect(metaLine(female, "Adult")).toBe("Perra adulta · Mediana");
    expect(metaLine(female, "Adult")).not.toContain("Esterilizada");
  });

  it("keeps size, which the table labels rather than repeats", () => {
    // Bare in the heading and labelled `Tamaño adulto` in the table, because a bare `Mediana`
    // does not say that for a puppy it is a prediction rather than an observation.
    expect(metaLine({ ...female, size: "Small" }, "Puppy")).toBe("Cachorra · Pequeña");
    expect(metaLine({ ...female, species: "cat", size: null }, "Adult")).toBe("Gata adulta");
  });

  it("is the line describeAnimal is built on, so the two cannot disagree", () => {
    // The composition rule — that a band word replaces the species word for a puppy — is the one
    // genuinely hard rule here, and it has to be the same on both surfaces.
    for (const band of ["Puppy", "Young", "Adult", "Senior"] as const) {
      expect(describeAnimal(female, band).startsWith(metaLine(female, band))).toBe(true);
    }
  });

  it("discloses an assumed gender exactly once, like every other composed line", () => {
    const unknown: AnimalWords = { ...female, sex: "Unknown" };
    const line = metaLine(unknown, "Adult");

    expect(line).toContain(SEX_UNKNOWN_NOTE);
    expect(line.split(SEX_UNKNOWN_NOTE)).toHaveLength(2);
  });
});
