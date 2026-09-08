/**
 * The rules that decide whether an animal may exist, and the rule that caps the urgency
 * mark.
 *
 * Everything here is a **creation-time** judgement rather than a lifecycle one, which is the
 * whole shape of issue #55: "the animal is complete the moment it exists". The row is
 * written last, after the photos it references are already stored
 * ([ADR 0012](../../docs/adr/0012-derivatives-are-generated-once-at-upload.md)), so
 * "between one and six photos, first primary" is an invariant of the insert instead of a
 * `Draft` state that something later has to leave. A rule that runs before a write can
 * refuse; a rule that runs after one can only report.
 *
 * In `domain/` rather than in `web/` because each rule below has more than one caller, which
 * is the bar `upload.ts` states and `web/src/lib/auth/policy.ts` deliberately does not meet.
 * The size pairing is asked by the publishing form, the publish path and the filter panel;
 * the urgency cap is asked by the form that offers the mark and by the path that saves it.
 * What is *not* here is every field bound and every Spanish sentence — those have one caller
 * each and live in `web/src/lib/animals/fields.ts`, next to `MAX_DISPLAY_NAME`.
 */

import { type Size, type Species, sizeApplies } from "./axes.ts";
import { MAX_PHOTOS_PER_ANIMAL, MIN_PHOTOS_PER_ANIMAL } from "./upload.ts";

/**
 * How an animal's estimated date of birth was arrived at.
 *
 * This exists so that **"about two years old" never reads to an adopter as a birthday.** The
 * platform stores a date because a date is what an age band can be derived from (ADR 0004),
 * but for most rescued animals that date is a guess — and a page that renders a precise date
 * it was given as a guess is asserting something nobody claimed. Recording the basis is what
 * lets the animal's page say how much the number is worth.
 *
 * Required alongside the date rather than nullable, because a null would be a fourth basis
 * meaning "we did not say", and the honest answer to "how do you know" is always one of these
 * three: `ShelterGuess` is what a shelter picks when it is guessing, and it is not a
 * confession — it is the common case and the reason this field exists.
 *
 * Not a filter axis. `CONTEXT.md` closes the axis list at six and this is not among them:
 * an adopter filters on the derived band, never on how confident the shelter was.
 */
export const AGE_ESTIMATE_BASES = [
  "Documented",
  "VetEstimate",
  "ShelterGuess",
] as const;

export type AgeEstimateBasis = (typeof AGE_ESTIMATE_BASES)[number];

export function isAgeEstimateBasis(value: string): value is AgeEstimateBasis {
  return (AGE_ESTIMATE_BASES as readonly string[]).includes(value);
}

/**
 * Whether an animal has been sterilised, as one of three answers rather than two.
 *
 * **Not a boolean, and that is the whole point.** `CONTEXT.md`'s vocabulary table gives this
 * attribute three renderings — `Esterilizado / Esterilizada`, `Sin esterilizar` and
 * `No se sabe` — and a boolean can express only the first two. The third is the common case
 * for a freshly rescued animal whose history nobody has: a shelter forced to answer yes or no
 * about a dog found last week is being made to guess, and a guess stored as a fact is worse
 * than the gap it filled, because an adopter reads `Sin esterilizar` and budgets for a surgery
 * that may already have happened.
 *
 * `Unknown` is a stored value rather than a `null` for the same reason a good-with flag's
 * `Unknown` is: the platform *displays* it. "No se sabe" is a sentence the animal's page says
 * out loud, and a null would leave each renderer to invent it.
 *
 * Not a filter axis — `CONTEXT.md` marks it display-only and closes the axis list at six —
 * which is why it lives here beside {@link AGE_ESTIMATE_BASES} rather than in `axes.ts`.
 */
export const STERILISATIONS = [
  "Sterilised",
  "NotSterilised",
  "Unknown",
] as const;

export type Sterilisation = (typeof STERILISATIONS)[number];

export function isSterilisation(value: string): value is Sterilisation {
  return (STERILISATIONS as readonly string[]).includes(value);
}

/**
 * How many animals one shelter may carry the urgency mark on at once.
 *
 * `CONTEXT.md`: "a flag rather than a scale, and capped per shelter, because an uncapped
 * scale drifts to all-high and stops meaning anything." The cap is what makes the mark worth
 * reading — a shelter with forty animals all marked urgent has told an adopter nothing, and
 * the drift is not bad faith but arithmetic: every animal in a shelter genuinely is urgent
 * to that shelter, so a scale with no ceiling has exactly one stable state.
 *
 * Three, and the number is small on purpose. It has to be small enough that choosing is a
 * real act — a shelter marking a fourth has to decide which of the three matters less, and
 * that decision is the entire information content of the flag.
 *
 * Per shelter and **concurrent**, not per month: it is a statement about right now, so
 * clearing one frees the slot immediately and nothing has to expire.
 */
export const MAX_URGENT_PER_SHELTER = 3;

/**
 * Why an animal cannot be published, or an urgency mark cannot be set.
 *
 * One union across both, because a publishing form reports them together in one response —
 * the same posture `fields.ts` takes about reporting every problem at once, and for the same
 * reason: each refused submission is a round trip on a connection ADR 0007 assumes is
 * metered.
 */
export type AnimalRefusalReason =
  /**
   * Not between one and six photos in the session.
   *
   * Zero is the case that matters and it is the one an `isPrimary` column would have let
   * through: an animal with no photos has no primary photo, so every single-image surface —
   * the card, the digest, the social preview — would have nothing to show, and the shelter
   * would find that out from an adopter. Refusing the insert is what makes "the first photo
   * is primary" true of every animal that exists rather than of most of them.
   */
  | "photo-count"
  /** A dog with no size. Asked of dogs, so a dog without one is an unanswered question. */
  | "size-required"
  /** A cat carrying a size. The bands are dog weight classes; a cat cannot have one. */
  | "size-not-applicable"
  /** The mark was set with nothing written in it. */
  | "urgency-reason-missing"
  /** This shelter already holds {@link MAX_URGENT_PER_SHELTER}. */
  | "urgency-cap-reached";

export interface AnimalRefusal {
  readonly reason: AnimalRefusalReason;
  /** The number the animal was judged against, where there is one. */
  readonly limit?: number;
  /** What the animal actually was, where it is known. */
  readonly actual?: number;
}

/**
 * What deciding whether an animal may exist needs to know, which is three facts.
 *
 * Deliberately **not** the whole animal. Nothing here needs the name, the description or the
 * good-with flags, because none of those can make an animal impossible — they are bounded
 * and validated, which is a different question, and answered in `web/`. Handing this a full
 * animal would invite the next rule to reach for a field instead of being asked for one.
 */
export interface AnimalDraftFacts {
  readonly species: Species;
  /** `null` where the shelter answered nothing, which is correct for a cat. */
  readonly size: Size | null;
  /**
   * How many photos are in the upload session this animal would be written from.
   *
   * Counted from rows that already exist, never from what a form claims to have uploaded.
   * That is the difference between an invariant and a hope: the photos are stored and their
   * derivatives are generated before this is asked, so a count of two means two sets of
   * derivatives are in the bucket right now.
   */
  readonly photoCount: number;
}

/**
 * Why this animal cannot be published, or `null`.
 *
 * The photo count is judged first, because it is the one refusal that is about work the
 * shelter has already done — it has been uploading, and being told about a missing size
 * before being told the upload did not take would send it to fix the wrong thing.
 *
 * The upper bound is {@link MAX_PHOTOS_PER_ANIMAL} rather than the storage mode's current
 * limit, and that asymmetry is deliberate. `photoLimitFor()` governs what may be *accepted*,
 * and it drops to one photo while R2 is filling up; this governs what may be *published*,
 * and the photos in hand were already accepted and already paid for. Judging a finished
 * session against a limit that tightened underneath it would refuse an animal for a reason
 * the shelter could do nothing about, and strand six sets of derivatives that the sweep would
 * then collect — spending the storage anyway and getting no listing for it.
 */
export function refuseAnimal(facts: AnimalDraftFacts): AnimalRefusal | null {
  if (facts.photoCount < MIN_PHOTOS_PER_ANIMAL) {
    return {
      reason: "photo-count",
      limit: MIN_PHOTOS_PER_ANIMAL,
      actual: facts.photoCount,
    };
  }
  if (facts.photoCount > MAX_PHOTOS_PER_ANIMAL) {
    return {
      reason: "photo-count",
      limit: MAX_PHOTOS_PER_ANIMAL,
      actual: facts.photoCount,
    };
  }

  return refuseSizePairing(facts);
}

/** An animal's species and the size it claims, which is all the pairing rule needs. */
export interface SizePairing {
  readonly species: Species;
  /** `null` where the shelter answered nothing, which is correct for a cat. */
  readonly size: Size | null;
}

/**
 * Why this species may not carry this size, or `null`.
 *
 * Separate from {@link refuseAnimal} because it has its own callers and they do not all have a
 * photo count to offer: the publishing form renders the control from it, the edit path judges a
 * changed species against an unchanged size, and the filter panel decides whether to offer the
 * axis once the species filter is narrowed. Reaching those callers through `refuseAnimal` would
 * mean handing it a photo count it should not be judging — a fabricated argument, which is how a
 * rule quietly starts answering a question nobody asked.
 *
 * Both directions, from one rule. A dog with no size and a cat with one are the same mistake seen
 * from either side, and asking `sizeApplies` rather than comparing to `"dog"` is what keeps the
 * answer in one place when a third species is argued for.
 */
export function refuseSizePairing(pairing: SizePairing): AnimalRefusal | null {
  const applies = sizeApplies(pairing.species);
  if (applies && pairing.size === null) return { reason: "size-required" };
  if (!applies && pairing.size !== null) {
    return { reason: "size-not-applicable" };
  }

  return null;
}

/** One urgency mark as a shelter is trying to set it. */
export interface UrgencyMark {
  /**
   * The written reason, already trimmed by the caller.
   *
   * Required, and it is not paperwork: an urgency mark with no reason is a claim an adopter
   * cannot weigh and a mark the shelter itself will not remember the grounds for when it has
   * to choose which three to keep. `CONTEXT.md` builds the reason into the definition —
   * "always carrying a written reason" — so a mark without one is not a mark.
   */
  readonly reason: string;
  /**
   * How many *other* animals of this shelter carry the mark right now.
   *
   * Other, excluding this one, so that re-saving an animal that is already marked is not
   * refused by its own mark. That is the bug the obvious count produces: an edit that changes
   * the wording of a reason on the shelter's third urgent animal would read three marks,
   * find the cap reached and refuse a change that adds no mark at all.
   */
  readonly otherUrgentCount: number;
}

/**
 * Why this urgency mark cannot be set, or `null`.
 *
 * Called only where a mark is being set. Clearing one is never refused — a shelter must
 * always be able to take the mark off, or the cap would be a trap rather than a budget.
 */
export function refuseUrgency(mark: UrgencyMark): AnimalRefusal | null {
  if (mark.reason.length === 0) return { reason: "urgency-reason-missing" };

  if (mark.otherUrgentCount >= MAX_URGENT_PER_SHELTER) {
    return {
      reason: "urgency-cap-reached",
      limit: MAX_URGENT_PER_SHELTER,
      actual: mark.otherUrgentCount,
    };
  }

  return null;
}
