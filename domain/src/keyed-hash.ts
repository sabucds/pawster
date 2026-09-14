/**
 * The one keyed hash the platform has, and the one table of labels that keeps its messages
 * apart.
 *
 * ## Why this moved here, and what would have broken if it had not
 *
 * It began in `web/src/lib/auth/crypto.ts`, whose comment states the property this file
 * exists to keep true: **"The labels table below spans every key in the platform,
 * deliberately. The property worth guaranteeing is that no two messages anywhere can be read
 * as each other, and a single list is what makes that checkable by reading one screen; a
 * labels table per feature would let two of them collide with nobody in a position to
 * notice."**
 *
 * Issue #62 gave the platform a third consumer. A manage link has to be *built* by `digest/`
 * — the ninety-day nudge carries one and that mail is sent from the cron — and *verified* by
 * `web/`, which serves the page it opens. `digest/` cannot import `web/`, so leaving the
 * primitive where it was would have forced a second `sign()` and a second labels table into
 * `digest/`, which is precisely the outcome the paragraph above rules out.
 * `digest/src/unsubscribe.ts` had already grown exactly that — a private `base64url` and a
 * private `sign` — and this file is where they go.
 *
 * `domain/` rather than `db/` for the reason `retention.ts` gives about its own periods: this
 * is arithmetic over bytes with no I/O, no schema and no clock, and `domain/` is the one
 * package all three consumers may import. `crypto.subtle` and `btoa` are globals in Workers
 * and in browsers alike, so the purity rules `scripts/check-source-rules.mjs` enforces over
 * this package — no `node:` builtins, no `@pawster/db`, no `fetch(` — are all still met, and
 * `browser-bundle.test.ts` still bundles the package for a browser.
 *
 * `web/src/lib/auth/crypto.ts` re-exports what is here and keeps its own wrappers, so every
 * existing call site is unchanged and there is still exactly one place a label is written
 * down.
 */

/**
 * Every keyed message in the platform, and the label that makes it unreadable as any other.
 *
 * Reusing one key for two purposes is safe only if the two message spaces cannot overlap, so
 * every message is domain-separated by a literal label **that no caller chooses**. Without
 * one, a value that could be read as either kind of message would produce a hash valid for
 * both, and the labels are what makes that impossible rather than merely unlikely.
 *
 * Which secret keys a given label is recorded on the label itself. The wrapper that calls
 * {@link sign} lives in the feature's own module rather than here —
 * `web/src/lib/auth/crypto.ts`, `web/src/lib/subscriber/crypto.ts`, `subscriber-links.ts`
 * next door.
 */
const LABELS = {
  /** A One-Time Code, bound to the shelter it was issued to. Keyed by `SIGN_IN_SECRET`. */
  code: "code:",
  /** A client IP fingerprint for the sign-in mail ledger. Keyed by `SIGN_IN_SECRET`. */
  ip: "ip:",
  /** A Session cookie payload. Keyed by `SESSION_SECRET`. */
  session: "session:",
  /**
   * A capability over one original object, handed to Cloudflare's image pipeline and to
   * nothing else (ADR 0012). Keyed by `ORIGINAL_SECRET`, which earns a secret of its own for
   * the reason `web/src/lib/photos/capability.ts` gives.
   */
  original: "original:",
  /**
   * An admin capability: a decision link, a pending-list link, or the revocation token that
   * only a terminal mints. Keyed by `ADMIN_LINK_SECRET`, which earns a key of its own because
   * it is rotated *when a link leaks out of the admin's inbox*, and that emergency must not
   * also invalidate every One-Time Code sitting in a shelter's inbox.
   */
  admin: "admin:",
  /** An opt-in link's token. Keyed by `SUBSCRIBER_SECRET`. */
  optIn: "optin:",
  /** A signup caller's IP fingerprint. Keyed by `SUBSCRIBER_SECRET`. */
  signupIp: "signup-ip:",
  /** A subscriber address's fingerprint in the opt-in mail ledger. Keyed by `SUBSCRIBER_SECRET`. */
  subscriber: "subscriber:",
  /**
   * A Do-Not-Contact entry. Keyed by `DO_NOT_CONTACT_PEPPER` and by nothing else — ADR 0010
   * requires a pepper that never rotates, and `web/src/lib/subscriber/crypto.ts` records why
   * that makes it a secret of its own rather than a further use of `SUBSCRIBER_SECRET`.
   */
  doNotContact: "dnc:",
  /**
   * A one-click unsubscribe link. Keyed by `SUBSCRIBER_LINK_SECRET`.
   *
   * Separated from {@link LABELS.manage} even though one secret keys both, and the separation
   * is load-bearing rather than tidy: the two tokens are built over overlapping material —
   * one subscriber id, with and without a version — and an unlabelled MAC over `"<id>"` could
   * be presented as the manage token for a subscriber whose id happened to end in `":0"`. The
   * labels make that unrepresentable.
   */
  unsubscribe: "unsub:",
  /**
   * A manage link, which is the subject-access response and carries the erasure button.
   * Keyed by `SUBSCRIBER_LINK_SECRET`.
   */
  manage: "manage:",
} as const;

export type KeyedHashPurpose = keyof typeof LABELS;

/**
 * Base64url without padding, which is what every keyed value in the platform is stored and
 * transmitted as. `=` is not URL-safe and `+`/`/` are not cookie-safe, so the standard
 * alphabet would have needed escaping at both boundaries.
 */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * `HMAC-SHA256(secret, label || message)` as base64url.
 *
 * The key is imported per call. That is deliberate rather than lazy: a `CryptoKey` cached at
 * module scope would outlive the request that created it, which is the same rule
 * `db/src/index.ts` states for the Drizzle client and the same reason —
 * `scripts/check-source-rules.mjs` only watches for Drizzle clients, so nothing would catch
 * this one. Importing a 32-byte HMAC key is arithmetic, not I/O.
 */
export async function sign(
  secret: string,
  purpose: KeyedHashPurpose,
  message: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(LABELS[purpose] + message),
  );
  return toBase64Url(signature);
}

/**
 * Compare two base64url digests without leaking, through timing, how far along they first
 * differ.
 *
 * `===` on strings short-circuits at the first differing character. For a *keyed* hash that is
 * a weak oracle — an attacker cannot choose the digest they are aiming at without the key —
 * but this is the comparison that stands between a guessed token and somebody else's data,
 * and writing the constant-time form costs three lines. Length is compared first and in the
 * clear, which reveals nothing: every digest here is the same width by construction.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
