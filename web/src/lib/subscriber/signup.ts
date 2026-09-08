/**
 * Reading the signup form: an address, six axes of criteria, and a locale.
 *
 * Pure — `FormData` in, a decision out. No database and no clock, which is what lets the two
 * judgements worth testing here be table tests rather than something only reachable by
 * posting a form.
 *
 * ## What this reports and what it must not
 *
 * The identical-response rule (issue #61's third criterion) is about **who the address
 * belongs to**: a new address, an already-subscribed one and a Do-Not-Contact one have to be
 * answered the same way, or the form becomes an oracle for who is subscribed. It is not about
 * the address's *shape*, and conflating the two costs a real subscriber a real thing.
 *
 * So a malformed address is reported, unlike on the sign-in path, where `parseCodeRequest()`
 * deliberately says nothing. That difference is the whole reason this is a separate function.
 * The sign-in form's answer to a typo has to be silence because saying "no such address"
 * *is* the enumeration answer there — the address either belongs to a shelter or it does not.
 * Here nobody is claimed to exist: `perez@gmial.com` is refused for looking wrong, which
 * reveals nothing about `perez@gmail.com`, and the alternative is an adopter waiting three
 * days for mail that was never going anywhere.
 *
 * The criteria themselves are read by `domain/`'s `parseCriteria()`, which drops what is not
 * a value on its axis **silently**, and that asymmetry is deliberate too: every closed
 * vocabulary value comes from a checkbox this platform rendered, so an invalid one means a
 * stale form or a crafted post — nothing a subscriber can act on.
 */

import type { SubscriptionCriteria } from "@pawster/domain";
import { MAX_CRITERIA_VALUES_PER_AXIS, parseCriteria } from "@pawster/domain";
import { looksLikeEmail, trimmedField } from "../form-fields.ts";
import { normaliseAddress } from "./crypto.ts";
import type { SubscriberLocale } from "./policy.ts";
import { parseLocale } from "./policy.ts";

export interface SignupInput {
  /** Normalised, and the form of the address every hash and every row uses. */
  readonly email: string;
  readonly criteria: SubscriptionCriteria;
  readonly locale: SubscriberLocale;
}

/** Rendered as one sentence. Only ever about the address — see the module comment. */
export interface SignupError {
  readonly field: "email";
  readonly reason: string;
}

export type SignupParse =
  | { readonly ok: true; readonly value: SignupInput }
  | { readonly ok: false; readonly errors: readonly SignupError[] };

const BAD_ADDRESS_REASON =
  "Revisa el correo: así como está escrito no podemos mandarte nada.";

/**
 * The closed axes, named by their `SubscriptionCriteria` key.
 *
 * The field names are the criteria keys rather than a separate wire vocabulary, so the form,
 * the parser and the stored column all say `ageBands` — one name is one fewer mapping to keep
 * in step, and `parseCriteria()` reads its axes off the same keys.
 */
const CLOSED_AXES = ["species", "sizes", "sexes", "ageBands", "goodWith"] as const;

/**
 * Every region the form submitted, as a flat list.
 *
 * Two wire forms are accepted, and both on purpose. Repeated `regions` fields are what a
 * `<select multiple>` or a set of checkboxes sends, which is what #56's filter panel will
 * offer once ADR 0005's reference data exists. Comma-separated text is what the form sends
 * today, because a subscriber in the Caracas commuter belt watches three states at once and
 * a single text box is the honest interim: ADR 0005 makes the vocabulary per-country
 * reference data, so nothing here can offer a list of it.
 *
 * Splitting is all this does — normalising, bounding the length and dropping duplicates are
 * `parseCriteria()`'s, so the open axis has exactly one set of rules however it arrived.
 * Truncation is left to it as well, for the same reason: it cuts *after* ordering.
 */
function readRegions(form: FormData): string[] {
  return form
    .getAll("regions")
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    /**
     * Bounded here as well as in the parser, because this is the one axis where the *input*
     * is unbounded rather than merely the output: a post with fifty thousand commas in it
     * would be split into fifty thousand strings before the parser ever saw it. The slice is
     * generous — twice the parser's own cap — so that ordinary over-submission is still
     * truncated by the vocabulary rule rather than by the arrival order.
     */
    .slice(0, MAX_CRITERIA_VALUES_PER_AXIS * 2);
}

/**
 * Read a signup, or the one reason it cannot be one.
 *
 * **An empty criteria is accepted, and reads as "send me everything".** `criteria.ts` leaves
 * that judgement to the caller because an empty set is legitimate for the digest and a
 * probable mistake at a form, and only the caller knows which. Here it is neither ambiguous
 * nor a mistake: the form says in so many words that ticking nothing means every animal, so a
 * subscriber who ticks nothing has been told what they are asking for. Refusing it would also
 * be refusing the most reasonable thing a Venezuelan adopter can ask a small platform for,
 * which is to be shown everything.
 */
export function parseSignup(form: FormData): SignupParse {
  const email = normaliseAddress(trimmedField(form, "email"));
  if (!looksLikeEmail(email)) {
    return { ok: false, errors: [{ field: "email", reason: BAD_ADDRESS_REASON }] };
  }

  const raw: Record<string, readonly string[]> = { regions: readRegions(form) };
  for (const field of CLOSED_AXES) {
    raw[field] = form
      .getAll(field)
      .filter((value): value is string => typeof value === "string");
  }

  return {
    ok: true,
    value: {
      email,
      criteria: parseCriteria(raw),
      locale: parseLocale(trimmedField(form, "locale")),
    },
  };
}

/**
 * The token an opt-in link carries, or `null`.
 *
 * `null` for absent, empty and over-long alike, and the caller answers all three with the
 * dead-link page. The bound is what keeps a hand-written URL from being signed: `sign()`
 * would happily HMAC a megabyte, and the only thing on the other side of that work is a
 * lookup that cannot match, since a real token is always 43 characters.
 */
export function parseOptInToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length === 0 || token.length > 128) return null;
  return token;
}
