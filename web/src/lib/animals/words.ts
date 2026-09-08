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
  AgeEstimateBasis,
  Availability,
  GoodWithAxis,
  GoodWithFlag,
  Sex,
  Size,
  Species,
  Sterilisation,
} from "@pawster/domain";
import { SIZE_ADULT_KILOGRAMS } from "@pawster/domain";

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
 * `Perro / Perra`, `Gato / Gata`.
 *
 * Not the age-band-aware headline: ADR 0018's replacement rule — where `Cachorra` and `Gatica`
 * name a species as well as a stage of life and so *replace* the species word — belongs with
 * whatever renders a band beside a species, and this ticket renders neither. Keeping the two
 * apart is deliberate: the ADR's whole point is that there is exactly one place a species word
 * and a band word meet, and this is not it. What is here is the species word alone.
 */
export const SPECIES_WORDS: Record<Species, Gendered> = {
  dog: { m: "Perro", f: "Perra" },
  cat: { m: "Gato", f: "Gata" },
};

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

/** The species as the publishing form offers it — the word alone, unmarked. */
export const SPECIES_OPTION_LABELS: Record<Species, string> = {
  dog: "Perro",
  cat: "Gato",
};

/** The three sterilisation answers as the form offers them, masculine and unmarked. */
export const STERILISATION_OPTION_LABELS: Record<Sterilisation, string> = {
  Sterilised: "Esterilizado",
  NotSterilised: "Sin esterilizar",
  Unknown: "No se sabe",
};

/** The three availabilities as the shelter's own edit form offers them. */
export const AVAILABILITY_OPTION_LABELS: Record<Availability, string> = {
  Available: "Disponible",
  Adopted: "Adoptado",
  NoLongerAvailable: "Ya no está disponible",
};

/**
 * The animal's structured attributes as one meta line, agreed and disclosed.
 *
 * The single composition point for these words. Every part goes through {@link agree} and the
 * whole goes through {@link sentence}, so an animal of unrecorded sex carries
 * `{@link SEX_UNKNOWN_NOTE}` exactly once no matter how many of its words bent to the masculine.
 *
 * Size is included only where it applies, which for a cat is never — the absence is the animal's
 * shape rather than a gap in what the shelter typed.
 */
export function describeAnimal(animal: AnimalWords): string {
  const parts: Resolved[] = [agree(SPECIES_WORDS[animal.species], animal.sex)];

  if (animal.size !== null) {
    parts.push(agree(SIZE_WORDS[animal.size], animal.sex));
  }

  parts.push(agree(STERILISATION_WORDS[animal.sterilisation], animal.sex));

  return sentence(parts);
}
