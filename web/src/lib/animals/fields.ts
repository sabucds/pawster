/**
 * The field rules the animal forms share, and the one copy of each of them.
 *
 * Two forms read these fields: the publishing form creates an animal from them, and the edit
 * form changes them. They had better agree, for the reason `../shelter/fields.ts` gives about
 * its own three forms — a description the edit form refuses but publishing accepts is an animal
 * that can exist and cannot be saved.
 *
 * Pure: `FormData` in, values and reasons out. No database, no clock (the one function that
 * needs *now* is handed it). Every reader returns the value **and** the reason it is unusable
 * rather than throwing, because both forms report every problem at once — ADR 0007 assumes a
 * metered connection, and a form that reports one error per submission makes a shelter with
 * three mistakes post four times.
 *
 * ## What is here and what is in `domain/`
 *
 * The split is not "validation here, rules there" but **caller count**, the bar `domain/`'s own
 * modules state. A field bound has one caller each and is a judgement about what a text box may
 * hold, so it lives here with the Spanish sentence that explains it. The dog-only size pairing,
 * the one-to-six photo count and the urgency cap have several callers each and are facts about
 * what an animal *is*, so they live in `domain/src/animal.ts` and this file does not restate
 * them: `readSize` below checks that a submitted size is a real size, and never that a cat
 * should not have one. `publish.ts` asks `refuseAnimal` for that and translates its answer.
 *
 * Restating a domain rule here would be the expensive kind of duplication — the copy would keep
 * agreeing with the rule right up until the ticket that changed one of them.
 */

import type {
  AgeEstimateBasis,
  Availability,
  GoodWithAxis,
  GoodWithFlag,
  GoodWithFlags,
  Sex,
  Size,
  Species,
  Sterilisation,
} from "@pawster/domain";
import {
  GOOD_WITH_AXES,
  isAgeEstimateBasis,
  isAvailability,
  isGoodWithFlag,
  isSex,
  isSize,
  isSpecies,
  isSterilisation,
} from "@pawster/domain";
import { type ReadField, trimmedField } from "../shelter/fields.ts";

export type { ReadField };

/**
 * Bounds rather than a judgement about names. Long enough for `Luna de los Valles`, short
 * enough that the field cannot be used as free storage — and short enough to fit a card, a
 * digest row and a page title without any of the three having to truncate it.
 */
export const MAX_ANIMAL_NAME = 60;

/**
 * Issue #55 asks for about 1,500 characters, and the number is a real ceiling rather than a
 * round one: it is roughly a screen of prose on a phone, which is as much as an adopter reads
 * before deciding to write. A shelter needing more is describing more than one animal, and the
 * platform has a Bonded Group for that.
 */
export const MAX_DESCRIPTION = 1500;

/**
 * Deliberately generous for free text about a condition. Enough for a diagnosis, a treatment
 * and a date — "leishmaniasis, en tratamiento hasta marzo, necesita control cada mes" — because
 * the field exists precisely so a condition the platform has no vocabulary for is still sayable.
 */
export const MAX_MEDICAL_NEEDS = 600;

/**
 * Short on purpose. The urgency reason is a claim an adopter weighs in a chip beside three other
 * animals, and a shelter given a large box writes a case history that nobody reads — which
 * costs the mark exactly the attention it was capped at three to protect.
 */
export const MAX_URGENT_REASON = 280;

/**
 * The oldest an animal's estimated birth date may be, in years.
 *
 * A bound on the *estimate* and not a claim about animals: the record is nearly 30 for a dog, so
 * this refuses a typo like `1902` and a mis-parsed field, and refuses nothing a shelter could
 * honestly mean. Chosen against the estimate rather than a fixed year so it does not expire.
 */
export const MAX_ANIMAL_AGE_YEARS = 30;

/**
 * One choice from a closed vocabulary, as it arrived and as it parsed.
 *
 * `raw` is kept beside `value` so a refused form can re-render showing what was submitted,
 * rather than silently resetting the control to nothing — the same reason `ReadField` returns
 * the value alongside its reason.
 */
export interface ReadChoice<T> {
  readonly value: T | null;
  readonly raw: string;
  readonly reason: string | null;
}

/**
 * One closed-vocabulary field, validated by `domain/`'s own guard.
 *
 * The guard is passed in rather than the list, because the guard *is* the vocabulary's opinion
 * of itself: a reader that compared against a list copied into `web/` would be a second answer
 * to "is this a real size", and the whole point of `CONTEXT.md` making every axis vocabulary
 * platform-owned is that there is one.
 *
 * Absence and a bad value are **different refusals**, so they take different messages, and
 * `missingReason` is optional because only some of these fields are required: `size` is
 * legitimately absent for a cat, and `sterilisation` never is. Omitting it makes a blank field
 * yield `null` with no reason, which is the caller saying "this one may be empty".
 *
 * Each reader below supplies both of its sentences, so the parse layer never has to invent one.
 * An earlier draft left the missing-value message to `publish.ts`, which meant five sentences
 * existed twice — the kind of duplication that keeps agreeing right up until the ticket that
 * changes one copy.
 */
function readChoice<T extends string>(
  form: FormData,
  name: string,
  guard: (value: string) => value is T,
  badReason: string,
  missingReason?: string,
): ReadChoice<T> {
  const raw = trimmedField(form, name);
  if (raw.length === 0) {
    return { value: null, raw, reason: missingReason ?? null };
  }
  if (!guard(raw)) return { value: null, raw, reason: badReason };
  return { value: raw, raw, reason: null };
}

/** One good-with axis's form control. The one place this name is spelled. */
export function goodWithControlName(axis: GoodWithAxis): string {
  return `goodWith.${axis}`;
}

/**
 * Every control the animal forms render, by form name.
 *
 * Exists so {@link readSubmittedValues} can rebuild a refused form without iterating the
 * `FormData` itself — `FormData.entries()` is not in the Workers runtime's types, and iterating
 * it would also copy whatever else a hand-made request happened to send into the values a page
 * then renders back. Naming the controls is both the portable way and the honest one.
 */
export const ANIMAL_CONTROL_NAMES: readonly string[] = [
  "name",
  "species",
  "sex",
  "size",
  "estimatedBirthDate",
  "ageEstimateBasis",
  "region",
  ...GOOD_WITH_AXES.map(goodWithControlName),
  "description",
  "medicalNeeds",
  "sterilisation",
  "availability",
  "urgent",
  "urgentReason",
];

/**
 * What the shelter just submitted, for every control, so a refusal comes back as it left.
 *
 * Absent controls become `""` rather than being skipped, and that is what makes clearing things
 * work. **An unticked checkbox is not submitted at all**, so a page that merged the submitted
 * values over the stored ones would keep showing the urgency mark of an animal the shelter had
 * just cleared — the tick would be impossible to remove.
 */
export function readSubmittedValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of ANIMAL_CONTROL_NAMES) {
    values[name] = trimmedField(form, name);
  }
  return values;
}

export function readAnimalName(form: FormData): ReadField {
  const value = trimmedField(form, "name");
  if (value.length === 0) {
    return { value, reason: "Escribe el nombre del animal." };
  }
  if (value.length > MAX_ANIMAL_NAME) {
    return {
      value,
      reason: `El nombre no puede pasar de ${MAX_ANIMAL_NAME} caracteres.`,
    };
  }
  return { value, reason: null };
}

/**
 * The animal's own region, which is **not** its shelter's.
 *
 * A separate field rather than an inherited one, because `CONTEXT.md` has an animal carry its
 * own region so that "a dog fostered in Valencia is findable by someone in Valencia". Only the
 * country is inherited. A form that defaulted this to the shelter's base region and hid the
 * control would quietly file every fostered animal in the wrong place.
 */
export function readAnimalRegion(form: FormData): ReadField {
  const value = trimmedField(form, "region");
  if (value.length === 0) {
    return { value, reason: "Escoge dónde está el animal." };
  }
  if (value.length > MAX_ANIMAL_NAME * 2) {
    return { value, reason: "Ese nombre es demasiado largo." };
  }
  return { value, reason: null };
}

export function readDescription(form: FormData): ReadField {
  const value = trimmedField(form, "description");
  if (value.length === 0) {
    return {
      value,
      reason: "Escribe algo sobre el animal. Es lo que más leen los adoptantes.",
    };
  }
  if (value.length > MAX_DESCRIPTION) {
    return {
      value,
      reason: `La descripción no puede pasar de ${MAX_DESCRIPTION} caracteres.`,
    };
  }
  return { value, reason: null };
}

/**
 * The medical needs, or `null` where the shelter left the box empty.
 *
 * Empty is a valid answer and not a refusal: most animals have nothing to declare, and a
 * required field here would be answered `ninguna` by every shelter within a week, which is a
 * column of noise rather than a column of facts.
 */
export function readMedicalNeeds(form: FormData): {
  readonly value: string | null;
  readonly reason: string | null;
} {
  const value = trimmedField(form, "medicalNeeds");
  if (value.length === 0) return { value: null, reason: null };
  if (value.length > MAX_MEDICAL_NEEDS) {
    return {
      value,
      reason: `Las necesidades médicas no pueden pasar de ${MAX_MEDICAL_NEEDS} caracteres.`,
    };
  }
  return { value, reason: null };
}

export function readSpecies(form: FormData): ReadChoice<Species> {
  const reason = "Escoge si es perro o gato.";
  return readChoice(form, "species", isSpecies, reason, reason);
}

export function readSex(form: FormData): ReadChoice<Sex> {
  const reason = "Escoge el sexo del animal.";
  return readChoice(form, "sex", isSex, reason, reason);
}

/**
 * The submitted size, checked against the vocabulary and **nothing else**.
 *
 * Whether this animal should have one at all is `domain/`'s `refuseAnimal`, asked by
 * `publish.ts`. A cat that arrives carrying `Medium` is a valid size on the wrong animal, and
 * those are two different refusals with two different messages.
 */
export function readSize(form: FormData): ReadChoice<Size> {
  return readChoice(form, "size", isSize, "Escoge el tamaño adulto.");
}

export function readAgeEstimateBasis(
  form: FormData,
): ReadChoice<AgeEstimateBasis> {
  const reason = "Escoge cómo saben la edad.";
  return readChoice(form, "ageEstimateBasis", isAgeEstimateBasis, reason, reason);
}

export function readSterilisation(form: FormData): ReadChoice<Sterilisation> {
  const reason = "Escoge si está esterilizado.";
  return readChoice(form, "sterilisation", isSterilisation, reason, reason);
}

/**
 * The availability, read only by the edit form.
 *
 * The publishing form submits none and never offers the control: publishing an animal *is*
 * making it available, and a shelter that could publish one as `Adopted` would be creating a
 * listing nobody can see in order to record something the platform has no use for.
 */
export function readAvailability(form: FormData): ReadChoice<Availability> {
  const reason = "Escoge en qué situación está el animal.";
  return readChoice(form, "availability", isAvailability, reason, reason);
}

export interface ReadGoodWith {
  /** Every axis answered, or `null` if any was missing or unknown to the platform. */
  readonly value: GoodWithFlags | null;
  readonly raw: Readonly<Record<string, string>>;
  readonly reason: string | null;
}

/**
 * All three good-with axes, answered.
 *
 * Iterated from `domain/`'s `GOOD_WITH_AXES` rather than named one by one, which is the same
 * reason that list is data: a fourth axis added there is read by this form the moment it exists
 * instead of being silently unasked.
 *
 * Every axis is **required**, and that is not a burden on the shelter because `Unknown` is one
 * of the three answers. Requiring an answer while offering "no se sabe" is what makes the field
 * mean something: a blank would be indistinguishable from an unrecorded observation, and the
 * platform would have to guess which of the two it was on every animal.
 */
export function readGoodWith(form: FormData): ReadGoodWith {
  const raw: Record<string, string> = {};
  const flags: Partial<Record<string, GoodWithFlag>> = {};
  let missing = false;

  for (const axis of GOOD_WITH_AXES) {
    const submitted = trimmedField(form, goodWithControlName(axis));
    raw[axis] = submitted;
    if (isGoodWithFlag(submitted)) flags[axis] = submitted;
    else missing = true;
  }

  if (missing) {
    return {
      value: null,
      raw,
      reason:
        "Responde las tres preguntas de convivencia. Si no lo saben, escoge «no se sabe».",
    };
  }

  return { value: flags as GoodWithFlags, raw, reason: null };
}

export interface ReadBirthDate {
  readonly value: Date | null;
  readonly raw: string;
  readonly reason: string | null;
}

/**
 * The estimated date of birth, from a `<input type="date">`.
 *
 * Parsed as **UTC midnight** rather than through the `Date` constructor's local-time path,
 * because the value is a calendar date a shelter typed and not an instant: parsed locally, a
 * date entered west of UTC becomes the previous day the moment it is stored, and an animal
 * born today could be refused as being in the future.
 *
 * `now` is a parameter, matching `domain/`'s posture that the thing which varies the answer is
 * an argument — a bound checked against a hidden clock cannot be tested at a boundary.
 */
export function readEstimatedBirthDate(
  form: FormData,
  now: Date,
): ReadBirthDate {
  const raw = trimmedField(form, "estimatedBirthDate");
  if (raw.length === 0) {
    return { value: null, raw, reason: "Escribe la fecha de nacimiento aproximada." };
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) {
    return { value: null, raw, reason: "Esa fecha no se entiende. Revísala." };
  }

  const [, year, month, day] = match;
  const value = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );

  /**
   * Rejects `2026-02-30` and `2026-13-01`, which `Date.UTC` rolls over into a real date rather
   * than refusing. Comparing the components back is the cheapest way to ask whether the date
   * the shelter typed is a date that exists.
   */
  if (
    value.getUTCFullYear() !== Number(year) ||
    value.getUTCMonth() !== Number(month) - 1 ||
    value.getUTCDate() !== Number(day)
  ) {
    return { value: null, raw, reason: "Ese día no existe. Revisa la fecha." };
  }

  if (value.getTime() > now.getTime()) {
    return {
      value: null,
      raw,
      reason: "La fecha de nacimiento no puede estar en el futuro.",
    };
  }

  const oldest = new Date(now.getTime());
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_ANIMAL_AGE_YEARS);
  if (value.getTime() < oldest.getTime()) {
    return {
      value: null,
      raw,
      reason: `Esa fecha da más de ${MAX_ANIMAL_AGE_YEARS} años. Revísala.`,
    };
  }

  return { value, raw, reason: null };
}

export interface ReadUrgency {
  /** The written reason, or `null` where the mark is not being set. */
  readonly value: string | null;
  readonly reason: string | null;
}

/**
 * The urgency mark as a form submitted it: a checkbox and the box beside it.
 *
 * Unchecked returns `null` and never looks at the text, so a shelter that types a reason and
 * then unticks the box is not marked urgent — the tick is the act. Checked with a blank box is
 * refused *here* rather than by `domain/`'s `refuseUrgency`, and the division is the same one
 * this file draws everywhere: the cap of three is a fact about the shelter that several callers
 * ask about, while "you ticked the box and wrote nothing" is this form talking to this shelter.
 *
 * The length bound is checked before the cap, because it is about what was typed and the cap is
 * about the other animals — telling a shelter it has run out of urgency slots when the real
 * problem is that its reason is too long would send it to fix the wrong thing.
 */
export function readUrgency(form: FormData): ReadUrgency {
  const marked = trimmedField(form, "urgent").length > 0;
  if (!marked) return { value: null, reason: null };

  const written = trimmedField(form, "urgentReason");
  if (written.length === 0) {
    return {
      value: null,
      reason:
        "Escribe por qué es urgente. La marca sin motivo no le dice nada a quien la lee.",
    };
  }
  if (written.length > MAX_URGENT_REASON) {
    return {
      value: written,
      reason: `El motivo no puede pasar de ${MAX_URGENT_REASON} caracteres.`,
    };
  }

  return { value: written, reason: null };
}
