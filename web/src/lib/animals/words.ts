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
import {
  SIZE_ADULT_KILOGRAMS,
  daysBetween,
  monthsBetween,
} from "@pawster/domain";
import type { ArchiveReason } from "./visibility.ts";

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

/** The three availabilities as the shelter's own edit form offers them. */
export const AVAILABILITY_OPTION_LABELS = optionLabels(AVAILABILITY_WORDS);

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

/* ------------------------------------------------------------------------------------- *
 * The animal page's own phrases (issue #57).
 *
 * Everything above describes an animal's *attributes*. Everything below describes what the
 * platform knows and how well it knows it — when the shelter last vouched for the animal, how
 * the age was arrived at, and what happened to an animal that has left the listing. They sit
 * in the same file because they inflect on the same fact — the animal's sex — and ADR 0018's
 * whole mechanism is that {@link agree} and {@link sentence} are the only places that happens.
 * ------------------------------------------------------------------------------------- */

/** `Confirmado / Confirmada` — it agrees with the animal, not with the confirmation. */
export const CONFIRMED_WORDS: Gendered = { m: "Confirmado", f: "Confirmada" };

/**
 * Who did the confirming, said out loud.
 *
 * Load-bearing rather than filler: without it the line reads as Pawster's own assurance, and
 * the platform has verified nothing about this animal. A Confirmation is *"a shelter's
 * deliberate write"* (`CONTEXT.md`), and the sentence has to name whose word it is.
 */
export const BY_THE_SHELTER = "por el refugio";

/**
 * The consequence — the sentence the animal page says and the listing card must not.
 *
 * The public-listing prototype settled that split: *"the card states a fact, the page states
 * the consequence"*, and it works *"because the page is where an adopter is about to spend a
 * message, not where they are scanning twelve animals"*. A card carrying this on every animal
 * would talk twelve adopters out of twelve enquiries at once.
 */
export const MAYBE_GONE = "Puede que ya no esté disponible";

/**
 * How long ago, in the words a person uses. Days, then weeks, then months.
 *
 * The unit coarsens as the number grows because that is how the number is read: `hace 3 días`
 * is a fact and `hace 47 días` is arithmetic the reader has to do. The thresholds are the
 * prototype's — under a week in days, under five weeks in weeks, months after that — which is
 * where the rounding stops being visible.
 *
 * A confirmation dated in the future (clock skew, or a shelter's device) reads as `hoy` rather
 * than throwing, the same forgiveness `deriveStalenessBand` extends for the same reason:
 * refusing to render the page is worse than rendering the kindest answer.
 */
export function agoPhrase(days: number): string {
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  if (days < 35) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? "hace 1 semana" : `hace ${weeks} semanas`;
  }
  const months = Math.round(days / 30);
  return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
}

/**
 * The provenance line, with its consequence — `Confirmada hace 4 meses por el refugio. Puede
 * que ya no esté disponible.`
 *
 * ## The consequence is unconditional, and the prototype's was not
 *
 * `prototypes/public-listing/index.html` appends the second sentence only past the fresh band.
 * This does not, and the divergence is deliberate. Pawster does not know whether an animal
 * confirmed yesterday is still available — no shelter has told it anything since — so the
 * sentence is exactly as true at one day as at four months, and printing it only when the
 * platform has grown *nervous* makes its presence the warning. That is the failure the
 * prototype itself named, resolved there for the card ("a uniform line, fresh included") and
 * left conditional on the page by habit.
 *
 * What varies instead is emphasis: the page styles the line amber past the fresh band, so a
 * stale animal still reads differently without the sentence appearing and disappearing. The
 * escalation is the colour, and the honesty is the sentence.
 *
 * Carries no `sexo no registrado` note of its own — {@link describeAnimal} renders above it and
 * discloses an assumed gender once for the whole page, which is the rule {@link ageBandLabel}
 * already follows and the reason both are safe to call {@link agree} directly.
 */
export function confirmationSentence(
  sex: Sex,
  lastConfirmedAt: Date,
  asOf: Date,
): string {
  const confirmed = agree(CONFIRMED_WORDS, sex).word;
  const ago = agoPhrase(daysBetween(lastConfirmedAt, asOf));
  return `${confirmed} ${ago} ${BY_THE_SHELTER}. ${MAYBE_GONE}.`;
}

/**
 * How the age was arrived at, as the parenthetical that follows it — `(estimada por el
 * refugio)`.
 *
 * **A second table for the same three values, and it earns being second.** The one above,
 * {@link AGE_BASIS_LABELS}, answers a question a form asks a shelter — `¿Cómo saben la edad?`
 * → `Lo estima el refugio` — in the second person and the active voice. This one modifies a
 * noun an adopter is reading: `unos 10 meses (estimada por el refugio)`. Putting `Lo estima el
 * refugio` in those brackets would be a clause where a phrase belongs, and rewriting the form's
 * options into this register would leave the form answering its own question with a fragment.
 *
 * They agree with different things and that is the tell that they are different strings: these
 * agree with `la edad`, feminine, which is why every one of them is `estimada` regardless of
 * the animal's sex.
 */
export const AGE_BASIS_NOTES: Record<AgeEstimateBasis, string> = {
  Documented: "según documentos",
  VetEstimate: "estimada por veterinario",
  ShelterGuess: "estimada por el refugio",
};

/**
 * The animal's age as a phrase — `10 meses`, `unos 3 años`.
 *
 * Months below eighteen and years above, because `unos 26 meses` is a number nobody says and
 * `unos 2 años` is what a shelter would have written. Never `0 meses`: an animal born this
 * month is `1 mes`, since a zero would read as missing data rather than as newborn.
 *
 * **`unos` appears for every basis but `Documented`**, and that hedge is the acceptance
 * criterion in one word. A shelter that ticked `ShelterGuess` said it was guessing, and
 * `3 años` renders that guess as a fact about the animal; `unos 3 años` renders it as what it
 * is. The parenthetical from {@link AGE_BASIS_NOTES} then says who guessed.
 */
export function ageText(
  estimatedBirthDate: Date,
  basis: AgeEstimateBasis,
  asOf: Date,
): string {
  const months = monthsBetween(estimatedBirthDate, asOf);
  const magnitude =
    months < 18
      ? pluralised(Math.max(1, months), "mes", "meses")
      : pluralised(Math.round(months / 12), "año", "años");
  return basis === "Documented" ? magnitude : `unos ${magnitude}`;
}

function pluralised(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The age and its basis as one value — `unos 10 meses (estimada por el refugio)`. */
export function ageWithBasis(
  estimatedBirthDate: Date,
  basis: AgeEstimateBasis,
  asOf: Date,
): string {
  return `${ageText(estimatedBirthDate, basis, asOf)} (${AGE_BASIS_NOTES[basis]})`;
}

/**
 * What an archive page says happened, in the animal's own gender.
 *
 * `CONTEXT.md` left the Archive row *unsettled*, marked as belonging to "the issue that builds
 * the archive page", and this is it. The concept is **never named to an adopter**: there is no
 * `archivo` heading and no "this listing is archived", because the adopter did not come to read
 * a filing status — they came to find out what happened to an animal. So the noun is absent
 * and the page states the event, which is the same shape `CONTEXT.md`'s *Staleness* and
 * *Session* rows already take.
 *
 * `Adopted` is the one that gets a whole sentence and a happy one. It is the outcome the
 * platform exists to produce, and an adopter who arrives late at a WhatsApp forward learns that
 * the animal she was about to write about found a home — which is the difference between a dead
 * link and a good ending.
 */
export const ARCHIVE_HEADLINES: Record<ArchiveReason, Gendered> = {
  Adopted: { m: "Encontró casa", f: "Encontró casa" },
  NoLongerAvailable: { m: "Ya no está disponible", f: "Ya no está disponible" },
  ShelterDeparted: { m: "Ya no está disponible", f: "Ya no está disponible" },
  ShelterUnreachable: { m: "Ya no está disponible", f: "Ya no está disponible" },
};

/**
 * The sentence under the headline, which is where the four reasons actually differ.
 *
 * Three of them share a headline above and are told apart here, because what an adopter needs
 * is not a category but the answer to "so what happened": the shelter said she is gone, the
 * shelter itself left Pawster, or — the case with no story — there is currently no way to reach
 * anyone about her.
 *
 * `Adopted` is worded so it cannot be misread as the platform's claim. `El refugio dice` is
 * doing the same work `por el refugio` does in the provenance line: this is a shelter's word,
 * reported, and Pawster witnessed no adoption.
 */
export const ARCHIVE_EXPLANATIONS: Record<ArchiveReason, Gendered> = {
  Adopted: {
    m: "El refugio dice que este animal ya fue adoptado. Gracias por venir a verlo.",
    f: "El refugio dice que esta animal ya fue adoptada. Gracias por venir a verla.",
  },
  NoLongerAvailable: {
    m: "El refugio dice que este animal ya no está disponible para adopción.",
    f: "El refugio dice que esta animal ya no está disponible para adopción.",
  },
  ShelterDeparted: {
    m: "El refugio que lo publicó ya no está en Pawster, así que no podemos ponerte en contacto.",
    f: "El refugio que la publicó ya no está en Pawster, así que no podemos ponerte en contacto.",
  },
  ShelterUnreachable: {
    m: "Ahora mismo el refugio no tiene ninguna forma de contacto publicada, así que no podemos ponerte en contacto.",
    f: "Ahora mismo el refugio no tiene ninguna forma de contacto publicada, así que no podemos ponerte en contacto.",
  },
};

/**
 * Said on every archive page, under the explanation.
 *
 * The page an adopter reached is a dead end for *this* animal and must not be a dead end for
 * the adopter, so the archive says where else to look. It is also the honest framing of what
 * the archive is: `CONTEXT.md` keeps the page reachable because "an animal is never deleted",
 * not because the animal is still on offer.
 */
export const ARCHIVE_ELSEWHERE = "Hay más animales esperando en el listado.";

/**
 * Why an archive page can be photoless, told to the reader rather than left as a blank space.
 *
 * Photos are dropped on the ordinary twelve-month clock, so an old archive page has nothing to
 * show and the alternative to this line is a page that looks broken. It says the absence was a
 * decision.
 */
export const ARCHIVE_PHOTOS_DROPPED =
  "Las fotos de este animal ya se borraron: no guardamos fotos de animales que salieron del listado.";
