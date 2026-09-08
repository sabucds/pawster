/**
 * The es-VE words for an animal's attributes, and the one place gender agreement happens.
 *
 * This is the first surface that renders a *particular* animal rather than a form control, so
 * it is the first place [ADR 0018](../../../../docs/adr/0018-strings-are-typed-phrase-functions.md)
 * bites: `Esterilizado` on a female dog is wrong, and it is wrong in the specific way that ADR
 * exists to design out — a phrase that still renders, still type-checks, and quietly asserts
 * something about the animal that nobody said.
 *
 * ## Why this file and not `strings/`
 *
 * ADR 0018 settles that UI copy becomes typed phrase functions in a fifth `strings/` workspace.
 * That workspace does not exist yet, and issue #55 is not the ticket that builds it — the same
 * position `../shelter/fields.ts` records for the shelter forms' labels. So the words are
 * hard-coded here, es-VE only, with **the ADR's mechanism rather than only its vocabulary**:
 * {@link agree} and {@link sentence} have the signatures the ADR specifies, gendered pairs are
 * `{ m, f }` records rather than positional tuples, and no caller in this folder joins two
 * translated words together. The extraction into `strings/` is then mechanical — move the
 * tables, add a locale parameter — instead of a rewrite that has to rediscover the rules.
 *
 * What is deliberately *not* copied from the ADR is the locale parameter. A phrase function is
 * `(locale, facts) => string` there; here it is `(facts) => string`, because a second locale
 * that does not exist would be a parameter every caller passes one value to.
 */

import type {
  AgeBand,
  AgeEstimateBasis,
  Availability,
  GoodWithAxis,
  GoodWithFlag,
  Sex,
  Size,
  Species,
  Sterilisation,
} from "@pawster/domain";
import { GOOD_WITH_AXES, SIZE_ADULT_KILOGRAMS } from "@pawster/domain";

/**
 * One word in both genders, masculine first.
 *
 * Named members rather than a positional pair, quoting ADR 0018's reason: "a two-element array
 * of strings type-checks in either order and the wrong order is invisible in review."
 *
 * Six of the ADR's fifteen pairs have identical members, so a pair whose halves match is not a
 * mistake — `Grande` and `Sin esterilizar` genuinely do not inflect. The type can enforce that a
 * pair exists; only a reader of the language can enforce that it is right.
 */
export interface Gendered {
  readonly m: string;
  readonly f: string;
}

/** A resolved word, carrying whether its gender was known or assumed. */
export interface Resolved {
  readonly word: string;
  readonly assumed: boolean;
}

/**
 * What an animal has to be to be described. Exactly the facts the words below vary on, and
 * nothing else — ADR 0018: "sex enters as a field of the facts the phrase function is given,
 * and nowhere else."
 */
export interface AnimalWords {
  readonly species: Species;
  readonly sex: Sex;
  readonly size: Size | null;
  readonly sterilisation: Sterilisation;
}

/**
 * Told when the masculine was used because nobody recorded a sex.
 *
 * Spanish's unmarked form is masculine, so there is no third form to reach for — but a bare
 * `Perro adulto` for an animal whose sex was never recorded reads as a claim about the animal.
 * The disclosure is what keeps it from being one.
 */
export const SEX_UNKNOWN_NOTE = "sexo no registrado";

/**
 * One word, agreed with the animal's sex, reporting whether the gender was assumed.
 *
 * Returns {@link Resolved} rather than a bare string, and that is the entire mechanism. A
 * string throws away the one bit the caller would then have to remember to re-derive, and
 * "remember to" is what ADR 0018 designs out: {@link sentence} appends the disclaimer once, so
 * a phrase cannot forget it without bypassing the combinator, which is a visible thing to do in
 * review rather than an omission.
 */
export function agree(word: Gendered, sex: Sex): Resolved {
  return sex === "Female"
    ? { word: word.f, assumed: false }
    : { word: word.m, assumed: sex === "Unknown" };
}

/**
 * The one place the disclaimer is appended, so no phrase function can forget it.
 *
 * Joined with `·` because these are attributes side by side rather than a clause — the meta
 * line of a card, not prose. The note is appended once even when several parts were assumed:
 * the reader is being told the sex is unrecorded, which is one fact about the animal however
 * many words it bent.
 */
export function sentence(parts: readonly Resolved[]): string {
  const words = parts.map((part) => part.word).join(" · ");
  return parts.some((part) => part.assumed)
    ? `${words} · ${SEX_UNKNOWN_NOTE}`
    : words;
}

/**
 * `Perro / Perra`, `Gato / Gata` — the species word alone.
 *
 * Read directly only by {@link speciesAndBand}, which is where the species word and a band word
 * are allowed to meet. Every surface that describes an animal goes through that function instead,
 * because for a puppy or a kitten the band word replaces this one rather than following it.
 */
export const SPECIES_WORDS: Record<Species, Gendered> = {
  dog: { m: "Perro", f: "Perra" },
  cat: { m: "Gato", f: "Gata" },
};

/**
 * The bands, as words. `CONTEXT.md`: `Cachorro / Cachorra`, `Gatico / Gatica`, `Joven`,
 * `Adulto / Adulta`, `Senior`.
 *
 * The last three are stored **lower-case** because that is how they occur: they are adjectives
 * following a noun, as in `Perra adulta`. {@link ageBandLabel} capitalises the first letter for
 * the one surface that shows a band on its own.
 *
 * `Gatico` and not `Gatito`: es-VE takes `-ico` after a `t` stem (`gato → gatico`, as
 * `rato → ratico`), which ADR 0018 settles against the prototype's spelling.
 */
export const AGE_BAND_WORDS: Record<AgeBand, Gendered> = {
  Puppy: { m: "Cachorro", f: "Cachorra" },
  Kitten: { m: "Gatico", f: "Gatica" },
  Young: { m: "joven", f: "joven" },
  Adult: { m: "adulto", f: "adulta" },
  Senior: { m: "senior", f: "senior" },
};

/**
 * The bands whose word **names a species as well as a stage of life**, and so replaces the
 * species word instead of following it.
 *
 * ADR 0018's second constraint, and the one that produced `Gata gatica` on the first prototype
 * render. Derived from the band rather than from a list of two names, so that a band added to
 * `domain/`'s union has to be classified here rather than silently composing the wrong way.
 */
function bandReplacesSpecies(band: AgeBand): boolean {
  return band === "Puppy" || band === "Kitten";
}

/**
 * The species and the band as one agreed phrase — `Cachorra`, `Perra adulta`, `Gato joven`.
 *
 * **The one place in the codebase where a species word and a band word meet**, which is ADR
 * 0018's whole point: the replacement rule is a fact about how two words combine, so it lives in
 * one function with a test rather than being restated at every call site that renders both.
 *
 * The join is inside this function and nowhere else. Spanish puts the noun first and the
 * adjective after it; English reverses that, which is the second reason this is a function
 * rather than a template.
 */
export function speciesAndBand(
  species: Species,
  band: AgeBand,
  sex: Sex,
): Resolved {
  if (bandReplacesSpecies(band)) return agree(AGE_BAND_WORDS[band], sex);

  const noun = agree(SPECIES_WORDS[species], sex);
  const adjective = agree(AGE_BAND_WORDS[band], sex);
  return {
    word: `${noun.word} ${adjective.word}`,
    assumed: noun.assumed || adjective.assumed,
  };
}

/**
 * One band on its own, for the surface that lists it as a labelled attribute.
 *
 * Capitalised, because standing alone it opens a value rather than trailing a noun. **Carries no
 * disclaimer**, and that is safe only because every page that renders this also renders
 * {@link describeAnimal} above it, which discloses an assumed gender once for the whole page.
 * A surface showing a band *without* the description would have to go through {@link sentence}.
 */
export function ageBandLabel(band: AgeBand, sex: Sex): string {
  const { word } = agree(AGE_BAND_WORDS[band], sex);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `Grande` and `Gigante` do not inflect; the first two do. */
export const SIZE_WORDS: Record<Size, Gendered> = {
  Small: { m: "Pequeño", f: "Pequeña" },
  Medium: { m: "Mediano", f: "Mediana" },
  Large: { m: "Grande", f: "Grande" },
  Giant: { m: "Gigante", f: "Gigante" },
};

/**
 * The concept English also genders — `Neutered` / `Spayed` — which is why the pair is stored
 * even though only the first member inflects in Spanish.
 */
export const STERILISATION_WORDS: Record<Sterilisation, Gendered> = {
  Sterilised: { m: "Esterilizado", f: "Esterilizada" },
  NotSterilised: { m: "Sin esterilizar", f: "Sin esterilizar" },
  Unknown: { m: "No se sabe", f: "No se sabe" },
};

/**
 * The sex itself, which is not gendered by the sex — it *is* the sex. `Macho` and `Hembra` are
 * nouns here, so there is no pair and nothing to agree with.
 */
export const SEX_LABELS: Record<Sex, string> = {
  Male: "Macho",
  Female: "Hembra",
  Unknown: "No se sabe",
};

/** What each good-with axis is called in the phrases below. */
const GOOD_WITH_NOUNS: Record<GoodWithAxis, string> = {
  children: "niños",
  dogs: "perros",
  cats: "gatos",
};

/**
 * One good-with answer as a phrase rather than as a word.
 *
 * `CONTEXT.md` writes the renderings as whole phrases — `No convive con gatos`,
 * `Sin evaluar: perros` — and that is the level the translation unit sits at: a caller is never
 * handed `convive` and an axis noun to join, because the negation and the not-yet-assessed form
 * are shaped differently and joining them correctly is the rule this function holds.
 *
 * Not gendered: the phrase agrees with the *other* animals, not with this one.
 */
export function goodWithPhrase(axis: GoodWithAxis, flag: GoodWithFlag): string {
  const noun = GOOD_WITH_NOUNS[axis];
  if (flag === "Yes") return `Convive con ${noun}`;
  if (flag === "No") return `No convive con ${noun}`;
  return `Sin evaluar: ${noun}`;
}

/**
 * The good-with axes as a form renders them: the question, not the answer.
 *
 * Second person and about the animal rather than about the adopter — a shelter is being asked
 * what it has observed, which is why every one of these can honestly be answered `No se sabe`.
 */
export const GOOD_WITH_QUESTIONS: Record<GoodWithAxis, string> = {
  children: "¿Convive con niños?",
  dogs: "¿Convive con otros perros?",
  cats: "¿Convive con gatos?",
};

/** The three answers a shelter picks between, in the order they are offered. */
export const GOOD_WITH_ANSWER_LABELS: Record<GoodWithFlag, string> = {
  Yes: "Sí",
  No: "No",
  Unknown: "No se sabe",
};

/**
 * How an animal's availability reads. `Adoptado / Adoptada` inflects; the other two are not
 * adjectives about the animal and do not.
 */
export const AVAILABILITY_WORDS: Record<Availability, Gendered> = {
  Available: { m: "Disponible", f: "Disponible" },
  Adopted: { m: "Adoptado", f: "Adoptada" },
  NoLongerAvailable: { m: "Ya no está disponible", f: "Ya no está disponible" },
};

/**
 * How the shelter said it knows the animal's age.
 *
 * `Estimado por el refugio` is worded without apology, because it is the common case and the
 * reason the field exists — a shelter picking it is answering the question, not confessing.
 */
export const AGE_BASIS_LABELS: Record<AgeEstimateBasis, string> = {
  Documented: "Tiene documentos",
  VetEstimate: "Lo estimó un veterinario",
  ShelterGuess: "Lo estima el refugio",
};

/** The question the basis answers, so the control is not a bare dropdown of three phrases. */
export const AGE_BASIS_QUESTION = "¿Cómo saben la edad?";

/**
 * A size as the publishing form offers it, kilograms included.
 *
 * The numbers come from `domain/`'s `SIZE_ADULT_KILOGRAMS` rather than being retyped, because
 * they are the *definition* of the vocabulary: a shelter choosing between `Medium` and `Large`
 * for a dog it is guessing about is answering a question about kilograms, and two shelters shown
 * different numbers would be filling in different fields.
 *
 * Masculine and undisclosed, unlike {@link describeAnimal}: an option in a list is naming a band,
 * not describing an animal, so there is no sex to agree with and nothing to disclose.
 */
export function sizeOptionLabel(size: Size): string {
  const [minimum, maximum] = SIZE_ADULT_KILOGRAMS[size];
  const word = SIZE_WORDS[size].m;
  if (maximum === null) return `${word} (más de ${minimum} kg)`;
  if (minimum === 0) return `${word} (menos de ${maximum} kg)`;
  return `${word} (${minimum}–${maximum} kg)`;
}

/**
 * Told to a shelter above the size control, and it is not a caveat — it is the question.
 *
 * Size means expected *adult* size, so for a puppy it is a prediction, and a shelter that read
 * the control as "how big is this dog now" would file every puppy as `Pequeño` and be filtered
 * to adopters looking for a small adult dog. Issue #55 requires the form to say so.
 */
export const SIZE_IS_ADULT_NOTE =
  "Escoge el tamaño que va a tener de adulto, no el de ahora. Si es un cachorro, es una " +
  "predicción: escoge lo que esperas.";

/**
 * Told to a shelter beside the good-with controls, and the reassurance is load-bearing.
 *
 * A shelter that suspects `No se sabe` costs it reach will answer `Sí` to everything, and the
 * flags stop describing animals. So the platform makes not-known cost nothing — a filter on one
 * axis still shows an animal whose answer is unknown — and then says so, because a guarantee
 * nobody is told about changes no behaviour.
 */
export const GOOD_WITH_UNKNOWN_IS_FREE_NOTE =
  "Responder «no se sabe» no le quita alcance: el animal igual aparece cuando alguien filtra " +
  "por esa convivencia. Responde solo lo que hayan visto.";

/**
 * A gendered pair as a form control offers it: the masculine, undisclosed.
 *
 * Derived from the pair rather than retyped beside it, so a word cannot be corrected in one
 * table and left stale in the other. An option in a list names a category and describes no
 * particular animal, so there is no sex to agree with and nothing to disclose — which is exactly
 * why it is safe to read `.m` directly here and nowhere else.
 */
function optionLabels<Key extends string>(
  words: Record<Key, Gendered>,
): Record<Key, string> {
  const labels = {} as Record<Key, string>;
  for (const key of Object.keys(words) as Key[]) labels[key] = words[key].m;
  return labels;
}

/** The species as the publishing form offers it — the word alone, unmarked. */
export const SPECIES_OPTION_LABELS = optionLabels(SPECIES_WORDS);

/** The three sterilisation answers as the form offers them, masculine and unmarked. */
export const STERILISATION_OPTION_LABELS = optionLabels(STERILISATION_WORDS);

/**
 * The five bands as the listing's filter panel offers them — `Cachorro`, `Gatico`, `Joven`,
 * `Adulto`, `Senior`.
 *
 * Capitalised, like {@link ageBandLabel} and for its reason: standing alone in a checkbox a
 * band opens a value rather than trailing a noun. Masculine and undisclosed, like every other
 * option label — a filter option names a category and describes no particular animal, so there
 * is no sex to agree with and nothing to disclose.
 *
 * Both first bands are offered, and that is the vocabulary rather than a duplication: a cat is
 * never `Puppy`, so `Cachorro` and `Gatico` are two different filters and an adopter looking
 * for a kitten is not served by a checkbox that says `Cachorro`.
 */
export const AGE_BAND_OPTION_LABELS: Record<AgeBand, string> = Object.fromEntries(
  (Object.keys(AGE_BAND_WORDS) as AgeBand[]).map((band) => [
    band,
    AGE_BAND_WORDS[band].m.charAt(0).toUpperCase() + AGE_BAND_WORDS[band].m.slice(1),
  ]),
) as Record<AgeBand, string>;

/** The three availabilities as the shelter's own edit form offers them. */
export const AVAILABILITY_OPTION_LABELS = optionLabels(AVAILABILITY_WORDS);

/**
 * `Confirmado / Confirmada` — the provenance line's verb, agreeing with the animal.
 *
 * The prototype's own pair, and the line it opens is the one thing #17 requires on **every**
 * card: `Miranda · Confirmada ayer`, `Aragua · Confirmado hace 4 meses`.
 */
export const CONFIRMED_WORDS: Gendered = {
  m: "Confirmado",
  f: "Confirmada",
};

/**
 * How long ago, in the words a person would actually use.
 *
 * Whole days in, a phrase out, and the buckets are chosen for how they read rather than for
 * arithmetic: `ayer` earns its own case because "hace 1 día" is not something anyone says, and
 * past a month the count switches to months because "hace 47 días" is a number the reader has
 * to convert. Months are approximated at 30 days, which is the same approximation the reader
 * is making.
 */
export function timeAgoPhrase(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "hace un mes" : `hace ${months} meses`;
}

/**
 * The listing card's provenance line: where the animal is, and when its shelter last said it
 * was true.
 *
 * **The same line, in the same position, on every card — fresh animals included.** That is
 * #17's finding and it is the opposite of an oversight: if the line appeared only when there
 * were something wrong, its *presence* would be the warning, and a badge that shows up on
 * ageing animals and nowhere else reads as "don't bother" however neutrally it is worded. What
 * makes the neutral label affordable is that the sort order is already doing the
 * de-emphasising — ADR 0001 gives staleness the ordering, so a stale animal has sunk by the
 * time an adopter reads its label, and the label does not need to do that job twice.
 *
 * **The consequence sentence is not here.** `Puede que ya no esté disponible.` belongs on the
 * animal page, where an adopter is about to spend a message, and not on a card they are
 * scanning twelve of: the card states a fact, the page states the consequence.
 *
 * Not routed through {@link sentence}, on the same terms as {@link ageBandLabel}: the card
 * renders {@link cardMetaLine} directly above this, which discloses an assumed gender once for
 * the whole card. A surface showing this line *without* that one would have to disclose.
 */
export function provenanceLine(
  animal: { readonly sex: Sex; readonly region: string },
  daysSinceConfirmed: number,
): string {
  const { word } = agree(CONFIRMED_WORDS, animal.sex);
  return `${animal.region} · ${word} ${timeAgoPhrase(daysSinceConfirmed)}`;
}

/**
 * The listing card's meta line — `Perra adulta · Mediana`.
 *
 * {@link describeAnimal}'s sibling, and the difference between them is the card's field budget
 * rather than an omission: sterilisation is prominent on the animal page and deliberately
 * absent from the card, because it changes the conversation rather than the shortlist (#17).
 * The filter index does not carry it either, so this is the phrase the card *can* build.
 *
 * Composed through {@link speciesAndBand} for ADR 0018's reason — for a puppy or a kitten the
 * band word **is** the species word — and closed by {@link sentence}, which makes this the one
 * place on the card where an assumed gender is disclosed.
 */
export function cardMetaLine(
  animal: { readonly species: Species; readonly sex: Sex; readonly size: Size | null },
  band: AgeBand,
): string {
  const parts: Resolved[] = [
    speciesAndBand(animal.species, band, animal.sex),
  ];
  if (animal.size !== null) {
    parts.push(agree(SIZE_WORDS[animal.size], animal.sex));
  }
  return sentence(parts);
}

/**
 * Several known-`Yes` axes as one merged phrase — `Con niños y gatos`.
 *
 * Merged rather than one chip each, because a positive is useful and not urgent and three of
 * them stacked is three lines saying "fine". The phrase is built here rather than by joining
 * {@link goodWithPhrase}'s output, which would read `Convive con niños · Convive con gatos`.
 *
 * Spanish's list conjunction is `y`, and `e` before a word beginning with an `i` sound —
 * none of the three nouns does, so the simple form is correct for the closed vocabulary this
 * can ever be handed.
 */
export function goodWithPositivesPhrase(
  axes: readonly GoodWithAxis[],
): string | null {
  if (axes.length === 0) return null;
  const nouns = axes.map((axis) => GOOD_WITH_NOUNS[axis]);
  if (nouns.length === 1) return `Con ${nouns[0]}`;
  return `Con ${nouns.slice(0, -1).join(", ")} y ${nouns[nouns.length - 1]}`;
}

/**
 * The unknown axes collapsed into **one named line** — `Sin evaluar: perros`, or
 * `Convivencia sin evaluar` when all three are.
 *
 * Still labelled, as `CONTEXT.md` requires — just once, collectively, rather than three times.
 * #17 measured the alternative: a tri-state chip row makes three stacked `no se sabe` chips
 * the visually heaviest element on four of twelve cards, gives non-information the same weight
 * as a genuine `No`, and costs +14% scroll to say less.
 *
 * The all-three case gets its own wording rather than listing every noun, because "nothing
 * about how this animal lives with others was assessed" is one fact rather than three.
 */
export function goodWithUnknownLine(
  axes: readonly GoodWithAxis[],
): string | null {
  if (axes.length === 0) return null;
  if (axes.length === GOOD_WITH_AXES.length) return "Convivencia sin evaluar";
  return `Sin evaluar: ${axes.map((axis) => GOOD_WITH_NOUNS[axis]).join(", ")}`;
}

/**
 * The animal's structured attributes as one meta line, agreed and disclosed.
 *
 * The single composition point for these words. Every part goes through {@link agree} and the
 * whole goes through {@link sentence}, so an animal of unrecorded sex carries
 * {@link SEX_UNKNOWN_NOTE} exactly once no matter how many of its words bent to the masculine.
 *
 * The band is composed with the species by {@link speciesAndBand} rather than added as a fourth
 * part, because for a puppy or a kitten the band word *is* the species word — appending it would
 * render `Gata gatica`, which is the failure ADR 0018 was written after seeing.
 *
 * The band is derived by `domain/`'s `deriveAgeBand()` and handed in, never stored (ADR 0004).
 *
 * Size is included only where it applies, which for a cat is never — the absence is the animal's
 * shape rather than a gap in what the shelter typed.
 */
export function describeAnimal(animal: AnimalWords, band: AgeBand): string {
  const parts: Resolved[] = [
    speciesAndBand(animal.species, band, animal.sex),
  ];

  if (animal.size !== null) {
    parts.push(agree(SIZE_WORDS[animal.size], animal.sex));
  }

  parts.push(agree(STERILISATION_WORDS[animal.sterilisation], animal.sex));

  return sentence(parts);
}
