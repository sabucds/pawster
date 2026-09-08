/**
 * Reading the profile forms, and refusing what would leave a shelter worse off than before.
 *
 * Pure, like `../auth/registration.ts` and for the same reason: the one rule worth testing
 * here — **the last contact point cannot be deleted** — is a table test rather than
 * something only reachable by posting a form.
 *
 * That rule is the whole reason this file is not just `parseRegistration` with a field
 * removed. At registration, "at least one contact point" prevents a shelter from publishing
 * animals nobody could ever see. Here it prevents something sharper: `domain/`'s `isListed()`
 * has a `contactPointCount > 0` clause, so a verified shelter that empties its last row
 * **delists everything it has already published**, silently, through a rule it never saw.
 * Nothing on the profile page would look wrong afterwards. So the refusal has to say what
 * would have happened, and the two forms say different things because they are describing
 * different losses.
 *
 * ## What is absent from this file
 *
 * There is no `slug` here and no way to reach one. `db/src/schema.ts` makes the slug
 * immutable — it is an address adopters and search engines already hold — and the enforcement
 * is that no query outside registration writes the column, checked structurally by
 * `scripts/check-source-rules.mjs`. A profile parser that read a `slug` field would be the
 * first half of breaking that, so it does not read one; a hand-made request carrying `slug`
 * is not refused, it is simply not looked at.
 */

import type { ContactPointInput } from "./fields.ts";
import {
  readAccountEmail,
  readBaseRegion,
  readContactPoints,
  readDisplayName,
} from "./fields.ts";

/** Rendered as one message each; the field name is the form control to point at. */
export interface ProfileError {
  readonly field: "displayName" | "baseRegion" | "contactPoints";
  readonly reason: string;
}

export interface ProfileInput {
  readonly displayName: string;
  readonly baseRegion: string;
  /** At least one, in the shelter's order. The first is the one an adopter is offered. */
  readonly contactPoints: readonly ContactPointInput[];
}

export type ProfileParse =
  | { readonly ok: true; readonly value: ProfileInput }
  | { readonly ok: false; readonly errors: readonly ProfileError[] };

/**
 * What a shelter is told when it tries to remove its last way of being reached.
 *
 * Phrased as a consequence rather than as a constraint, and in the present tense, because
 * the shelter is about to make animals that are visible today stop being visible. "Se
 * necesita al menos una" would be true and would tell it nothing it could act on.
 */
export const LAST_CONTACT_POINT_REASON =
  "Tienes que dejar al menos una forma de contacto. Si las quitas todas, tus animales " +
  "dejan de aparecer en el sitio, porque no habría manera de escribirte por ellos.";

/**
 * Every problem at once rather than the first one, matching `parseRegistration`.
 *
 * The contact points come back **in the order the shelter put them in**, and that order is
 * the whole of what the store persists: position is the array index. There is nothing here
 * that says which point is primary, because the first one is.
 */
export function parseProfile(form: FormData): ProfileParse {
  const errors: ProfileError[] = [];

  const displayName = readDisplayName(form);
  if (displayName.reason) {
    errors.push({ field: "displayName", reason: displayName.reason });
  }

  const baseRegion = readBaseRegion(form);
  if (baseRegion.reason) {
    errors.push({ field: "baseRegion", reason: baseRegion.reason });
  }

  const contacts = readContactPoints(form, LAST_CONTACT_POINT_REASON);
  for (const reason of contacts.reasons) {
    errors.push({ field: "contactPoints", reason });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      displayName: displayName.value,
      baseRegion: baseRegion.value,
      contactPoints: contacts.points,
    },
  };
}

export type AccountEmailParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The address a shelter wants to hold its account under from now on.
 *
 * Typed **twice**, and the confirmation field is not form politeness. This one act ends
 * every live session and invalidates every outstanding link, and the address it moves to is
 * the only thing that can ever authenticate the shelter again — so a typo here is not a
 * validation message, it is an account nobody can reach, recoverable only out of band
 * (ADR 0013 answers a lost inbox "not as a password reset but as a question of identity").
 * A confirmation field costs one input and catches the one mistake that has no undo.
 *
 * Compared before either is used, so the two must match exactly after normalisation — which
 * is where the lower-casing in `fields.ts` earns its keep: `Hola@Refugio.example` and
 * `hola@refugio.example` are the same inbox and must not read as a mismatch.
 */
export function parseAccountEmailChange(form: FormData): AccountEmailParse {
  const next = readAccountEmail(form, "accountEmail");
  if (next.reason) return { ok: false, reason: next.reason };

  const again = readAccountEmail(form, "accountEmailAgain");
  if (again.value !== next.value) {
    return {
      ok: false,
      reason:
        "Los dos correos no son iguales. Escríbelo otra vez para confirmar, porque con " +
        "este correo es que se entra.",
    };
  }

  return { ok: true, value: next.value };
}
