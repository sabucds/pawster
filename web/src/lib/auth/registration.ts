/**
 * Reading a registration form, and refusing one that cannot become a shelter.
 *
 * Pure: it takes `FormData` and returns either an input for `registerShelter()` or a list
 * of reasons. No database, no clock. That is what lets the one rule worth testing here —
 * **at least one contact point** — be a table test rather than something only reachable by
 * posting a form.
 *
 * That rule is the ticket's reason for asking a registration form for contact points at
 * all, and it is not paperwork: `domain/`'s `isListed()` has a `contactPointCount > 0`
 * clause, so an animal published by a shelter with no contact points would be invisible —
 * and invisible for a reason the shelter has no way to see, because nothing on its own
 * publishing screen is missing. The cheapest place to make that impossible is the form that
 * creates the shelter.
 */

import type { ContactPointKind } from "@pawster/db";
import type { ContactPointInput, RegistrationInput } from "./store.ts";

/**
 * The four channels an adopter reaches a shelter through (`CONTEXT.md`, *Contact Point*).
 * Data as well as a type, because the parser validates against it and the form renders
 * from it — one list, so a fifth channel cannot be accepted by one and unknown to the other.
 */
export const CONTACT_POINT_KINDS = [
  "whatsapp",
  "instagram",
  "email",
  "phone",
] as const satisfies readonly ContactPointKind[];

/** Rendered as one message each; the field name is the form control to point at. */
export interface RegistrationError {
  readonly field:
    | "displayName"
    | "accountEmail"
    | "baseRegion"
    | "countryCode"
    | "contactPoints";
  readonly reason: string;
}

export type RegistrationParse =
  | { readonly ok: true; readonly value: RegistrationInput }
  | { readonly ok: false; readonly errors: readonly RegistrationError[] };

/**
 * Bounds rather than a judgement about names. Long enough for
 * `Fundación Protectora de Animales del Estado Miranda`, short enough that the value cannot
 * be used as free storage.
 */
const MAX_DISPLAY_NAME = 120;
const MAX_FIELD = 200;

/**
 * Deliberately permissive: something, an `@`, something with a dot in it, and no spaces.
 *
 * A stricter regex is the classic mistake here. The address is the shelter's **whole
 * credential** (ADR 0013), so a false rejection is not a validation message, it is a
 * shelter that cannot join the platform — and the real check happens anyway, the first time
 * a code is sent to it and someone has to read it. This exists to catch a typo like a
 * missing `@`, not to adjudicate RFC 5322.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse the contact points out of the repeated `contactKind` / `contactValue` pairs.
 *
 * Positional pairing, which is what an HTML form gives: the browser submits the controls in
 * document order, so the nth kind belongs to the nth value. A row whose value is blank is
 * **dropped rather than rejected** — the form renders several empty rows and a shelter
 * filling in one of them has not made a mistake. A row with a value but an unknown kind is
 * rejected, because that can only come from a hand-made request.
 */
function parseContactPoints(form: FormData): {
  points: ContactPointInput[];
  errors: RegistrationError[];
} {
  const kinds = form.getAll("contactKind");
  const values = form.getAll("contactValue");
  const points: ContactPointInput[] = [];
  const errors: RegistrationError[] = [];

  for (const [index, rawValue] of values.entries()) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (value.length === 0) continue;

    if (value.length > MAX_FIELD) {
      errors.push({
        field: "contactPoints",
        reason: `Una forma de contacto no puede pasar de ${MAX_FIELD} caracteres.`,
      });
      continue;
    }

    const rawKind = kinds[index];
    const kind = typeof rawKind === "string" ? rawKind : "";
    if (!isContactPointKind(kind)) {
      errors.push({
        field: "contactPoints",
        reason: "Escoge de qué tipo es cada forma de contacto.",
      });
      continue;
    }

    points.push({ kind, value });
  }

  if (points.length === 0 && errors.length === 0) {
    errors.push({
      field: "contactPoints",
      reason:
        "Hace falta al menos una forma de contacto: sin ninguna, tus animales no le " +
        "aparecerían a nadie.",
    });
  }

  return { points, errors };
}

function isContactPointKind(value: string): value is ContactPointKind {
  return (CONTACT_POINT_KINDS as readonly string[]).includes(value);
}

/**
 * Every problem at once rather than the first one.
 *
 * A form that reports one error per submission makes a shelter with three typos post four
 * times, and each post is a round trip on a connection this platform assumes is metered
 * and slow (ADR 0007).
 */
export function parseRegistration(form: FormData): RegistrationParse {
  const errors: RegistrationError[] = [];

  const displayName = field(form, "displayName");
  if (displayName.length === 0) {
    errors.push({ field: "displayName", reason: "Escribe el nombre del refugio." });
  } else if (displayName.length > MAX_DISPLAY_NAME) {
    errors.push({
      field: "displayName",
      reason: `El nombre no puede pasar de ${MAX_DISPLAY_NAME} caracteres.`,
    });
  }

  /**
   * Lower-cased here, which is the *only* place either path normalises it, so registration
   * and sign-in cannot disagree about what "the same inbox" means. The column is unique, so
   * a shelter that registered `Hola@Refugio.example` and later typed
   * `hola@refugio.example` has to find its own row.
   */
  const accountEmail = field(form, "accountEmail").toLowerCase();
  if (accountEmail.length === 0) {
    errors.push({
      field: "accountEmail",
      reason: "Escribe el correo del refugio.",
    });
  } else if (accountEmail.length > MAX_FIELD || !EMAIL_SHAPE.test(accountEmail)) {
    errors.push({
      field: "accountEmail",
      reason: "Ese correo no parece completo. Revísalo.",
    });
  }

  const baseRegion = field(form, "baseRegion");
  if (baseRegion.length === 0) {
    errors.push({ field: "baseRegion", reason: "Escoge dónde está el refugio." });
  } else if (baseRegion.length > MAX_FIELD) {
    errors.push({ field: "baseRegion", reason: "Ese nombre es demasiado largo." });
  }

  /**
   * Two letters, upper-cased. ADR 0005 puts regions inside a country and `CONTEXT.md` has
   * an animal inherit its country from its shelter, so this is the root of that inheritance
   * and an ISO 3166-1 alpha-2 code is the least the reference data can be keyed by.
   */
  const countryCode = field(form, "countryCode").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    errors.push({ field: "countryCode", reason: "Escoge el país." });
  }

  const { points, errors: contactErrors } = parseContactPoints(form);
  errors.push(...contactErrors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      displayName,
      accountEmail,
      baseRegion,
      countryCode,
      contactPoints: points,
    },
  };
}

/**
 * The address a code request was made for, or `null` if the field is unusable.
 *
 * Separate from {@link parseRegistration} and much thinner on purpose: the sign-in form has
 * one field and must not report anything about it. `null` here becomes the same response a
 * perfectly valid unregistered address gets, so a malformed address cannot be told from a
 * well-formed stranger either.
 */
export function parseCodeRequest(form: FormData): string | null {
  const accountEmail = field(form, "accountEmail").toLowerCase();
  if (accountEmail.length === 0 || accountEmail.length > MAX_FIELD) return null;
  if (!EMAIL_SHAPE.test(accountEmail)) return null;
  return accountEmail;
}

/**
 * The digits a shelter typed, or `null`.
 *
 * Spaces are stripped before the length check, because a shelter reading a code off another
 * device types `123 456` about as often as `123456` and rejecting that would be a bug the
 * shelter would read as a wrong code.
 */
export function parseSubmittedCode(form: FormData, digits: number): string | null {
  const raw = field(form, "code").replace(/[\s-]/g, "");
  if (raw.length !== digits) return null;
  if (!/^\d+$/.test(raw)) return null;
  return raw;
}
