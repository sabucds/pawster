/**
 * Reading a registration form, and refusing one that cannot become a shelter — plus the two
 * much thinner parsers the sign-in path needs.
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
 *
 * **The field rules themselves live in `../shelter/fields.ts`**, not here, because the
 * profile form edits the same fields (issue #52) and a display-name bound that held on one
 * form and not the other would be a shelter that can exist and cannot be saved. What stays
 * in this file is what is true of registration alone: which fields it asks for, and that an
 * empty contact list at *creation* is described as animals that would never appear rather
 * than as animals about to disappear.
 */

import { looksLikeEmail, trimmedField } from "../form-fields.ts";
import {
  readAccountEmail,
  readBaseRegion,
  readContactPoints,
  readCountryCode,
  readDisplayName,
} from "../shelter/fields.ts";
import type { RegistrationInput } from "./store.ts";

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
 * What a shelter is told when it submits a registration with no contact point.
 *
 * Conditional, unlike the profile form's version: nothing of this shelter's exists yet, so
 * the loss being described is hypothetical. The profile form is describing animals that are
 * visible right now, and says so — see `LAST_CONTACT_POINT_REASON`.
 */
const NO_CONTACT_POINT_REASON =
  "Hace falta al menos una forma de contacto: sin ninguna, tus animales no le " +
  "aparecerían a nadie.";

/**
 * Every problem at once rather than the first one.
 *
 * A form that reports one error per submission makes a shelter with three typos post four
 * times, and each post is a round trip on a connection this platform assumes is metered
 * and slow (ADR 0007).
 */
export function parseRegistration(form: FormData): RegistrationParse {
  const errors: RegistrationError[] = [];

  const displayName = readDisplayName(form);
  if (displayName.reason) {
    errors.push({ field: "displayName", reason: displayName.reason });
  }

  const accountEmail = readAccountEmail(form);
  if (accountEmail.reason) {
    errors.push({ field: "accountEmail", reason: accountEmail.reason });
  }

  const baseRegion = readBaseRegion(form);
  if (baseRegion.reason) {
    errors.push({ field: "baseRegion", reason: baseRegion.reason });
  }

  const countryCode = readCountryCode(form);
  if (countryCode.reason) {
    errors.push({ field: "countryCode", reason: countryCode.reason });
  }

  const contacts = readContactPoints(form, NO_CONTACT_POINT_REASON);
  for (const reason of contacts.reasons) {
    errors.push({ field: "contactPoints", reason });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      displayName: displayName.value,
      accountEmail: accountEmail.value,
      baseRegion: baseRegion.value,
      countryCode: countryCode.value,
      contactPoints: contacts.points,
    },
  };
}

/**
 * The address a code request was made for, or `null` if the field is unusable.
 *
 * Separate from {@link parseRegistration} and much thinner on purpose: the sign-in form has
 * one field and must not report anything about it. `null` here becomes the same response a
 * perfectly valid unregistered address gets, so a malformed address cannot be told from a
 * well-formed stranger either — which is why this reads the shape directly rather than
 * through `readAccountEmail`, whose whole job is to produce a reason to show.
 */
export function parseCodeRequest(form: FormData): string | null {
  const accountEmail = trimmedField(form, "accountEmail").toLowerCase();
  return looksLikeEmail(accountEmail) ? accountEmail : null;
}

/**
 * The digits a shelter typed, or `null`.
 *
 * Spaces are stripped before the length check, because a shelter reading a code off another
 * device types `123 456` about as often as `123456` and rejecting that would be a bug the
 * shelter would read as a wrong code.
 */
export function parseSubmittedCode(form: FormData, digits: number): string | null {
  const raw = trimmedField(form, "code").replace(/[\s-]/g, "");
  if (raw.length !== digits) return null;
  if (!/^\d+$/.test(raw)) return null;
  return raw;
}
