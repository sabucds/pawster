/**
 * Reading the animal forms, and saying in Spanish why an animal may not exist.
 *
 * Pure, like `../shelter/profile.ts` and `../auth/registration.ts`: `FormData` and a few facts
 * in, either a complete animal or every reason it is not one. No database and no clock — the
 * photo count, the shelter's other urgency marks and *now* are all handed in, because each is a
 * fact about the world at one moment and a parser that fetched them could not be tested at a
 * boundary.
 *
 * ## This file translates refusals; it does not make them
 *
 * `domain/src/animal.ts` decides whether an animal may exist — the one-to-six photo count, the
 * dog-only size pairing, the cap of three urgency marks. This file asks it and turns its answer
 * into a sentence a shelter can act on. That is why {@link REFUSAL_MESSAGES} is a mapping rather
 * than a series of `if`s: every member of `AnimalRefusalReason` has to have a sentence, so a
 * reason added in `domain/` is a type error here instead of an animal refused with no
 * explanation.
 *
 * The one refusal that is *made* here is a blank urgency reason, and `fields.ts` records why:
 * "you ticked the box and wrote nothing" is this form talking to this shelter, while the cap is
 * a fact about the shelter that several callers ask about.
 */

import type {
  AgeEstimateBasis,
  AnimalRefusal,
  AnimalRefusalReason,
  Availability,
  GoodWithFlags,
  Sex,
  Size,
  Species,
  Sterilisation,
} from "@pawster/domain";
import {
  MAX_PHOTOS_PER_ANIMAL,
  MAX_URGENT_PER_SHELTER,
  MIN_PHOTOS_PER_ANIMAL,
  refuseAnimal,
  refuseSizePairing,
  refuseUrgency,
} from "@pawster/domain";
import {
  readAgeEstimateBasis,
  readAnimalName,
  readAnimalRegion,
  readAvailability,
  readDescription,
  readEstimatedBirthDate,
  readGoodWith,
  readMedicalNeeds,
  readSex,
  readSize,
  readSpecies,
  readSterilisation,
  readUrgency,
} from "./fields.ts";

/**
 * The form control a message points at.
 *
 * `photos` is on the list even though the publishing form has no photo control of its own — the
 * photos were uploaded in a step before this one, so the message has to be attachable to
 * something, and attaching it to nothing is how a refusal becomes a form that looks fine and
 * will not save.
 */
export type AnimalField =
  | "name"
  | "region"
  | "species"
  | "sex"
  | "size"
  | "estimatedBirthDate"
  | "ageEstimateBasis"
  | "goodWith"
  | "description"
  | "medicalNeeds"
  | "sterilisation"
  | "availability"
  | "urgency"
  | "photos";

/** Rendered as one message each; the field is the control to point at. */
export interface AnimalError {
  readonly field: AnimalField;
  readonly reason: string;
}

/**
 * A complete animal as a form gave it, with everything the store needs and nothing it does not.
 *
 * No `id`, no `shelterId`, no `uploadSessionId`, no timestamps: those are the store's to assign,
 * and a parser that invented them would be the second place they were decided. No `availability`
 * either — see {@link AnimalEditInput}.
 */
export interface AnimalInput {
  readonly name: string;
  readonly region: string;
  readonly species: Species;
  readonly sex: Sex;
  /** `null` for a cat, which `domain/`'s `refuseAnimal` has already agreed to. */
  readonly size: Size | null;
  readonly estimatedBirthDate: Date;
  readonly ageEstimateBasis: AgeEstimateBasis;
  readonly goodWith: GoodWithFlags;
  readonly description: string;
  readonly medicalNeeds: string | null;
  readonly sterilisation: Sterilisation;
  /** The written reason, or `null` for an animal not carrying the mark. */
  readonly urgentReason: string | null;
}

/**
 * An edit, which is everything a publish is plus the animal's situation.
 *
 * `availability` appears only here because publishing an animal *is* making it available, and
 * the three states only become a choice once the animal exists.
 */
export interface AnimalEditInput extends AnimalInput {
  readonly availability: Availability;
}

/**
 * What the caller has to know before it can judge a publish.
 *
 * `photoCount` is counted from stored rows and never from what the form claims — the difference
 * between an invariant and a hope, as `domain/`'s `AnimalDraftFacts` puts it.
 *
 * `otherUrgentCount` excludes the animal being saved, which matters on the edit path: counting
 * it would refuse a shelter's third urgent animal for merely rewording its own reason.
 */
export interface PublishFacts {
  readonly now: Date;
  readonly photoCount: number;
  readonly otherUrgentCount: number;
}

/** An edit judges no photo count: the photos are the session's and this form does not touch them. */
export interface EditFacts {
  readonly now: Date;
  readonly otherUrgentCount: number;
}

export type AnimalParse =
  | { readonly ok: true; readonly value: AnimalInput }
  | { readonly ok: false; readonly errors: readonly AnimalError[] };

export type AnimalEditParse =
  | { readonly ok: true; readonly value: AnimalEditInput }
  | { readonly ok: false; readonly errors: readonly AnimalError[] };

/**
 * Where each of `domain/`'s refusals is shown, and what it says.
 *
 * A total mapping over `AnimalRefusalReason`, which is the point: a reason added to the union in
 * `domain/` fails to compile here until someone writes the sentence for it. The alternative — a
 * `switch` with a default — would refuse the animal and tell the shelter nothing.
 *
 * The messages take the refusal so they can quote the number the animal was judged against
 * rather than repeating a literal that could drift from `domain/`'s own constant.
 */
export const REFUSAL_MESSAGES: Record<
  AnimalRefusalReason,
  (refusal: AnimalRefusal) => AnimalError
> = {
  "photo-count": (refusal) => ({
    field: "photos",
    reason:
      (refusal.actual ?? 0) < MIN_PHOTOS_PER_ANIMAL
        ? `Sube al menos ${MIN_PHOTOS_PER_ANIMAL} foto antes de publicar. Sin foto, el ` +
          "animal no se puede mostrar en ningún lado."
        : `No puedes publicar con más de ${MAX_PHOTOS_PER_ANIMAL} fotos.`,
  }),
  "size-required": () => ({
    field: "size",
    reason: "Escoge el tamaño que va a tener de adulto. Se pregunta solo para perros.",
  }),
  "size-not-applicable": () => ({
    field: "size",
    reason: "El tamaño es solo para perros, porque las medidas son de peso de perro.",
  }),
  "urgency-reason-missing": () => ({
    field: "urgency",
    reason: "Escribe por qué es urgente.",
  }),
  "urgency-cap-reached": () => ({
    field: "urgency",
    reason:
      `Ya tienes ${MAX_URGENT_PER_SHELTER} animales marcados como urgentes. Quítale la marca ` +
      "a uno para poder marcar este: el límite es lo que hace que la marca signifique algo.",
  }),
};

/** One refusal as the message and control it belongs to. */
export function describeRefusal(refusal: AnimalRefusal): AnimalError {
  return REFUSAL_MESSAGES[refusal.reason](refusal);
}

/**
 * Every field both forms share, read once.
 *
 * Returns the errors *and* the partially-read values, because the two forms then ask different
 * further questions of them — a publish judges the photo count, an edit reads the availability —
 * and neither can do that from a bare list of messages.
 */
function readShared(form: FormData, now: Date) {
  const errors: AnimalError[] = [];

  const name = readAnimalName(form);
  if (name.reason) errors.push({ field: "name", reason: name.reason });

  const region = readAnimalRegion(form);
  if (region.reason) errors.push({ field: "region", reason: region.reason });

  /**
   * Every reader below reports its own missing-value sentence, so each of these is the same one
   * line: `fields.ts` owns the words and this owns which control they hang off. The earlier
   * shape — `x.reason ?? "…"` — put a second copy of five sentences here.
   */
  const species = readSpecies(form);
  if (species.reason) {
    errors.push({ field: "species", reason: species.reason });
  }

  const sex = readSex(form);
  if (sex.reason) errors.push({ field: "sex", reason: sex.reason });

  /**
   * Only the vocabulary is judged here. Whether *this* animal should carry a size is
   * `refuseAnimal`'s, asked below once the species is known — and asked even when the species
   * failed to parse, in which case the pairing is simply not reachable and says nothing.
   */
  const size = readSize(form);
  if (size.reason) errors.push({ field: "size", reason: size.reason });

  const birthDate = readEstimatedBirthDate(form, now);
  if (birthDate.reason) {
    errors.push({ field: "estimatedBirthDate", reason: birthDate.reason });
  }

  const basis = readAgeEstimateBasis(form);
  if (basis.reason) {
    errors.push({ field: "ageEstimateBasis", reason: basis.reason });
  }

  const goodWith = readGoodWith(form);
  if (goodWith.reason) {
    errors.push({ field: "goodWith", reason: goodWith.reason });
  }

  const description = readDescription(form);
  if (description.reason) {
    errors.push({ field: "description", reason: description.reason });
  }

  const medicalNeeds = readMedicalNeeds(form);
  if (medicalNeeds.reason) {
    errors.push({ field: "medicalNeeds", reason: medicalNeeds.reason });
  }

  const sterilisation = readSterilisation(form);
  if (sterilisation.reason) {
    errors.push({ field: "sterilisation", reason: sterilisation.reason });
  }

  const urgency = readUrgency(form);
  if (urgency.reason) errors.push({ field: "urgency", reason: urgency.reason });

  return {
    errors,
    name,
    region,
    species,
    sex,
    size,
    birthDate,
    basis,
    goodWith,
    description,
    medicalNeeds,
    sterilisation,
    urgency,
  };
}

/**
 * Judges what `domain/` owns, given whatever parsed.
 *
 * Only asked where the inputs it needs actually arrived. A species that failed to parse makes the
 * size pairing unanswerable rather than failing — reporting "a cat cannot have a size" to a
 * shelter that has not yet said which species it is would be inventing a refusal out of a
 * missing field.
 */
function judgeDomainRules(
  shared: ReturnType<typeof readShared>,
  facts: { readonly photoCount?: number; readonly otherUrgentCount: number },
): readonly AnimalError[] {
  const errors: AnimalError[] = [];
  const species = shared.species.value;

  if (species !== null) {
    /**
     * The publish path judges the whole draft; the edit path judges only the pairing, because it
     * has no photo count and `refuseSizePairing` is the entry point that does not ask for one.
     */
    const refusal =
      facts.photoCount === undefined
        ? refuseSizePairing({ species, size: shared.size.value })
        : refuseAnimal({
            species,
            size: shared.size.value,
            photoCount: facts.photoCount,
          });
    if (refusal) errors.push(describeRefusal(refusal));
  }

  /**
   * Asked only where a mark is actually being set. Clearing one is never refused — a shelter must
   * always be able to take the mark off, or the cap would be a trap rather than a budget — and
   * `readUrgency` has already refused a tick with nothing written in it.
   */
  if (shared.urgency.value !== null && shared.urgency.reason === null) {
    const refusal = refuseUrgency({
      reason: shared.urgency.value,
      otherUrgentCount: facts.otherUrgentCount,
    });
    if (refusal) errors.push(describeRefusal(refusal));
  }

  return errors;
}

/**
 * Assembles the parsed animal, once every reader is known to have succeeded.
 *
 * The `!` assertions are safe because {@link readShared} pushed an error for each of these fields
 * being absent, and both callers return early when the error list is non-empty. They are
 * assertions rather than a second round of checks so that the shape is stated once: a caller
 * reaching here has already been told the animal is complete. Re-checking instead would read as
 * though the absence were still possible, and would need a branch with nothing to put in it.
 */
function assemble(shared: ReturnType<typeof readShared>): AnimalInput {
  return {
    name: shared.name.value,
    region: shared.region.value,
    species: shared.species.value!,
    sex: shared.sex.value!,
    size: shared.size.value,
    estimatedBirthDate: shared.birthDate.value!,
    ageEstimateBasis: shared.basis.value!,
    goodWith: shared.goodWith.value!,
    description: shared.description.value,
    medicalNeeds: shared.medicalNeeds.value,
    sterilisation: shared.sterilisation.value!,
    urgentReason: shared.urgency.value,
  };
}

/**
 * An animal as the publishing form submitted it, or every reason it cannot be published.
 *
 * Every problem at once, matching `parseProfile` and `parseRegistration`. The photo count is
 * judged first among the domain rules for the reason `refuseAnimal` states: it is the one
 * refusal about work the shelter has already done, and being told about a missing size before
 * being told the upload did not take would send it to fix the wrong thing.
 */
export function parsePublish(form: FormData, facts: PublishFacts): AnimalParse {
  const shared = readShared(form, facts.now);
  const errors = [
    ...shared.errors,
    ...judgeDomainRules(shared, {
      photoCount: facts.photoCount,
      otherUrgentCount: facts.otherUrgentCount,
    }),
  ];

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: assemble(shared) };
}

/**
 * An animal as its edit form submitted it, or every reason the edit cannot be saved.
 *
 * The photos are untouched, so no photo count is judged. What is added is the availability,
 * which is the one field that only exists once the animal does.
 */
export function parseEdit(form: FormData, facts: EditFacts): AnimalEditParse {
  const shared = readShared(form, facts.now);
  const errors = [
    ...shared.errors,
    ...judgeDomainRules(shared, { otherUrgentCount: facts.otherUrgentCount }),
  ];

  const availability = readAvailability(form);
  if (availability.reason) {
    errors.push({ field: "availability", reason: availability.reason });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      ...assemble(shared),
        availability: availability.value!,
    },
  };
}
