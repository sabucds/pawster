/**
 * The field rules the shelter-facing forms share, and the one copy of each of them.
 *
 * Three forms now read the same fields: registration creates a shelter from them
 * (`../auth/registration.ts`), the profile form edits them (`profile.ts`), and the
 * account-email form changes the credential. They had better agree — a display name the
 * profile form refuses but registration accepts is a shelter that can exist and cannot be
 * saved, and a contact-point rule that drifted between the two would let a shelter delist
 * itself through a form that had no such rule.
 *
 * Pure, like everything either caller is built on: `FormData` in, values and reasons out.
 * No database, no clock. Every function here returns the value **and** the reason it is
 * unusable, rather than throwing, because every one of these forms reports every problem at
 * once — a form that reports one error per submission makes a shelter with three typos post
 * four times, and each post is a round trip on a connection ADR 0007 assumes is metered.
 *
 * Each caller maps a `reason` onto its own field union rather than a shared one, because
 * the unions are genuinely different: registration has a `countryCode` field and the
 * profile form has none, and a union covering both would let each of them name a control
 * that is not on the page.
 */

import type { ContactPointKind } from "@pawster/db";

/**
 * The four channels an adopter reaches a shelter through (`CONTEXT.md`, *Contact Point*).
 * Data as well as a type, because the parsers validate against it and the forms render
 * from it — one list, so a fifth channel cannot be accepted by one and unknown to the other.
 */
export const CONTACT_POINT_KINDS = [
  "whatsapp",
  "instagram",
  "email",
  "phone",
] as const satisfies readonly ContactPointKind[];

/**
 * What each kind is called on screen, in es-VE.
 *
 * Here rather than in each page because two forms render this list — registration and the
 * profile — and a channel called `Correo` on one and `Email` on the other is the exact
 * failure `CONTEXT.md`'s *User-facing Spanish* table exists to catch. Hard-coded for the
 * same reason the shelter-facing layout is: ADR 0018 settles that UI strings become typed
 * phrase functions in a `strings/` workspace, and that workspace does not exist yet.
 */
export const CONTACT_POINT_LABELS: Record<ContactPointKind, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  email: "Correo",
  phone: "Teléfono",
};

/**
 * One contact point as a form submitted it, with **no position of its own**.
 *
 * The order is the array's order. Position is assigned by the store from the index, so
 * there is no second field that can disagree with where the item actually sits — the same
 * reason there is no `primary` boolean in `db/`'s `shelter_contact_points`.
 */
export interface ContactPointInput {
  readonly kind: ContactPointKind;
  readonly value: string;
}

/**
 * Bounds rather than a judgement about names. Long enough for
 * `Fundación Protectora de Animales del Estado Miranda`, short enough that the value cannot
 * be used as free storage.
 */
export const MAX_DISPLAY_NAME = 120;
export const MAX_FIELD = 200;

/**
 * Deliberately permissive: something, an `@`, something with a dot in it, and no spaces.
 *
 * A stricter regex is the classic mistake here. The address is the shelter's **whole
 * credential** (ADR 0013), so a false rejection is not a validation message, it is a
 * shelter that cannot join the platform — or, on the profile form, one that cannot hand its
 * account to a successor. The real check happens anyway, the first time a code is sent to it
 * and someone has to read it. This exists to catch a typo like a missing `@`, not to
 * adjudicate RFC 5322.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A value and the reason it cannot be used, or `null` when it can.
 *
 * The value is returned either way, so a refused form can come back filled in with what the
 * shelter typed rather than blank.
 */
export interface ReadField {
  readonly value: string;
  readonly reason: string | null;
}

/**
 * One text field, trimmed, with a missing or non-string value reported as `""`.
 *
 * Collapsing absent and empty is deliberate: a browser submits an empty control rather than
 * omitting it, so the two are the same event, and every caller below treats `""` as "not
 * given". A `File` value — which `FormData.get` can also return — is not a text field and is
 * refused the same way.
 */
export function trimmedField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function readDisplayName(form: FormData): ReadField {
  const value = trimmedField(form, "displayName");
  if (value.length === 0) {
    return { value, reason: "Escribe el nombre del refugio." };
  }
  if (value.length > MAX_DISPLAY_NAME) {
    return {
      value,
      reason: `El nombre no puede pasar de ${MAX_DISPLAY_NAME} caracteres.`,
    };
  }
  return { value, reason: null };
}

export function readBaseRegion(form: FormData): ReadField {
  const value = trimmedField(form, "baseRegion");
  if (value.length === 0) {
    return { value, reason: "Escoge dónde está el refugio." };
  }
  if (value.length > MAX_FIELD) {
    return { value, reason: "Ese nombre es demasiado largo." };
  }
  return { value, reason: null };
}

/**
 * The account email, lower-cased.
 *
 * **This is the only place either path normalises it**, so registration, sign-in and an
 * email change cannot disagree about what "the same inbox" means. The column is unique, so a
 * shelter that registered `Hola@Refugio.example` and later typed `hola@refugio.example` has
 * to find its own row.
 */
export function readAccountEmail(form: FormData, name = "accountEmail"): ReadField {
  const value = trimmedField(form, name).toLowerCase();
  if (value.length === 0) {
    return { value, reason: "Escribe el correo del refugio." };
  }
  if (value.length > MAX_FIELD || !EMAIL_SHAPE.test(value)) {
    return { value, reason: "Ese correo no parece completo. Revísalo." };
  }
  return { value, reason: null };
}

/** Whether a string is a usable address, for the paths that must report nothing at all. */
export function looksLikeEmail(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FIELD && EMAIL_SHAPE.test(value);
}

/**
 * Two letters, upper-cased. ADR 0005 puts regions inside a country and `CONTEXT.md` has an
 * animal inherit its country from its shelter, so this is the root of that inheritance and
 * an ISO 3166-1 alpha-2 code is the least the reference data can be keyed by.
 */
export function readCountryCode(form: FormData): ReadField {
  const value = trimmedField(form, "countryCode").toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return { value, reason: "Escoge el país." };
  return { value, reason: null };
}

export interface ReadContactPoints {
  /** In the shelter's chosen order. The first is the one an adopter is offered. */
  readonly points: readonly ContactPointInput[];
  readonly reasons: readonly string[];
}

/**
 * The contact points, in the order the shelter put them in.
 *
 * ## Positional pairing, which is what an HTML form gives
 *
 * The browser submits repeated controls in document order, so the nth `contactKind` belongs
 * to the nth `contactValue` and the nth `contactPosition`. A row whose value is blank is
 * **dropped rather than rejected** — a form renders spare empty rows and a shelter filling
 * in one of them has not made a mistake, and on the profile form emptying a row is how a
 * contact point is deleted. A row with a value but an unknown kind is rejected, because that
 * can only come from a hand-made request.
 *
 * ## How the order is expressed, and why it is a typed number
 *
 * `contactPosition` is a number the shelter edits, one per row, and the rows are sorted by
 * it. Two alternatives were considered and both are worse here. Drag-and-drop needs
 * JavaScript, and every shelter-facing page in this group deliberately ships none (ADR 0007:
 * the payload is small on a metered connection and each of these pages is a form that has to
 * work before anything arrives). Per-row up/down submit buttons work without JavaScript but
 * make the endpoint two endpoints — a move and a save — with the move having to persist the
 * half-finished edits around it or silently discard them.
 *
 * A typed number's failure mode is duplicates and gaps, and it is handled rather than
 * validated: the sort is **stable**, so equal numbers keep document order, and the position
 * actually stored is the index in this array. A shelter that types `1, 1, 5` gets exactly
 * what it asked for and is never shown an error about numbering. A row with no
 * `contactPosition` at all — the registration form, which submits none — falls back to its
 * document position, so that form's rows stay in the order they appear on screen.
 *
 * @param emptyReason What to say when nothing is left. It differs by form: registration is
 *   describing animals that would never appear, and the profile form is describing a shelter
 *   about to delist animals that are visible right now.
 */
export function readContactPoints(
  form: FormData,
  emptyReason: string,
): ReadContactPoints {
  const kinds = form.getAll("contactKind");
  const values = form.getAll("contactValue");
  const positions = form.getAll("contactPosition");
  const rows: { point: ContactPointInput; order: number; index: number }[] = [];
  const reasons: string[] = [];

  for (const [index, rawValue] of values.entries()) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value.length === 0) continue;

    if (value.length > MAX_FIELD) {
      reasons.push(
        `Una forma de contacto no puede pasar de ${MAX_FIELD} caracteres.`,
      );
      continue;
    }

    const rawKind = kinds[index];
    const kind = typeof rawKind === "string" ? rawKind : "";
    if (!isContactPointKind(kind)) {
      reasons.push("Escoge de qué tipo es cada forma de contacto.");
      continue;
    }

    rows.push({ point: { kind, value }, order: readOrder(positions[index], index), index });
  }

  if (rows.length === 0 && reasons.length === 0) reasons.push(emptyReason);

  /**
   * Sorted by the typed number, ties broken by document order. `Array.prototype.sort` is
   * required to be stable, so the tiebreak is spelled out anyway — it is the rule that makes
   * duplicate numbers well-defined rather than merely unspecified, and reading it here is
   * cheaper than trusting a reader to know the specification says so.
   */
  rows.sort((a, b) => a.order - b.order || a.index - b.index);

  return { points: rows.map((row) => row.point), reasons };
}

/**
 * One row's typed order, falling back to its position on the page.
 *
 * Anything unparseable falls back too, rather than becoming an error. The number is a
 * convenience for expressing an order and never a fact the shelter has to get right; the
 * order it actually gets is the one this function computes, and the form re-renders showing
 * it.
 */
function readOrder(raw: FormDataEntryValue | undefined, index: number): number {
  if (typeof raw !== "string") return index;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : index;
}

function isContactPointKind(value: string): value is ContactPointKind {
  return (CONTACT_POINT_KINDS as readonly string[]).includes(value);
}
