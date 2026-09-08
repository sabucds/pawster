/**
 * The two form primitives every path shares: reading a text field, and deciding whether a
 * string could be an email address at all.
 *
 * Extracted from `shelter/fields.ts` when subscriber signup became the third consumer.
 * `web/src/lib/auth/policy.ts` states the rule this follows — a pure module with exactly one
 * consumer belongs in the package that consumes it — and the same test read the other way
 * moves these out of a shelter module the moment an adopter's form needs them. Nothing here
 * is about shelters: a trimmed field is a trimmed field, and the address bound below is the
 * platform's, not a shelter's.
 *
 * What stays in `shelter/fields.ts` is everything that produces a *reason to show a shelter*,
 * because those are that area's words and its judgements about its own fields.
 */

/**
 * Bounds rather than a judgement about content. Long enough for any real address or region
 * name, short enough that a value cannot be used as free storage by anyone who finds a form.
 */
export const MAX_FIELD = 200;

/**
 * Deliberately permissive: something, an `@`, something with a dot in it, and no spaces.
 *
 * A stricter regex is the classic mistake here, and it costs more on each of the two paths
 * that use it than it could ever save. For a shelter the address is its **whole credential**
 * (ADR 0013), so a false rejection is not a validation message but a shelter that cannot join
 * — or one that cannot hand its account to a successor. For a subscriber it is the only way
 * the platform can reach them at all. The real check happens anyway, the first time mail is
 * sent to it and somebody has to read it. This exists to catch a missing `@`, not to
 * adjudicate RFC 5322.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One text field, trimmed, with a missing or non-string value reported as `""`.
 *
 * Collapsing absent and empty is deliberate: a browser submits an empty control rather than
 * omitting it, so the two are the same event, and every caller treats `""` as "not given". A
 * `File` value — which `FormData.get` can also return — is not a text field and is refused
 * the same way.
 */
export function trimmedField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Whether a string is a usable address, for the paths that decide without explaining. */
export function looksLikeEmail(value: string): boolean {
  return value.length > 0 && value.length <= MAX_FIELD && EMAIL_SHAPE.test(value);
}

/** Whether a string is a usable address, for the paths that have a reason to give. */
export function isEmailShaped(value: string): boolean {
  return value.length <= MAX_FIELD && EMAIL_SHAPE.test(value);
}
