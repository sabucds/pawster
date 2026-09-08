/**
 * The primitives shelter access is built from: one keyed hash, one unbiased random code,
 * one opaque token, and a comparison that does not leak where two strings first differ.
 *
 * All of it is WebCrypto, which the Workers runtime supplies as a global — no `node:crypto`
 * and no dependency. `HMAC-SHA256` is the same primitive ADR 0010 chose for Do-Not-Contact,
 * and ADR 0013 calls it "cheap enough to ignore the CPU ceiling", unlike the password
 * hashing that ceiling ruled out.
 *
 * ## Why one secret and not three
 *
 * `SIGN_IN_SECRET` keys the code hash and the IP fingerprint; `SESSION_SECRET` signs the
 * cookie. Two secrets rather than four, because every additional secret is another thing
 * `wrangler secret put` has to be told about and another way a deploy can be half-configured.
 *
 * Reusing one key for two purposes is only safe if the two message spaces cannot overlap,
 * so every message here is **domain-separated by a literal label** — `code:`, `ip:`,
 * `session:` — that no caller chooses. Without it, a value that could be read as either
 * kind of message would produce a hash valid for both, and the labels are what makes that
 * impossible rather than merely unlikely.
 */

import { ONE_TIME_CODE_DIGITS, ONE_TIME_CODE_SPACE } from "./policy.ts";

const LABELS = {
  /** A One-Time Code, bound to the shelter it was issued to. */
  code: "code:",
  /** A client IP fingerprint for the sign-in mail ledger. */
  ip: "ip:",
  /** A Session cookie payload. */
  session: "session:",
  /**
   * A capability over one original object, handed to Cloudflare's image pipeline and to
   * nothing else (ADR 0012). Keyed by `ORIGINAL_SECRET` rather than by either of the two
   * above — see `web/src/lib/photos/capability.ts` for why this one earns a third secret.
   */
  original: "original:",
} as const;

type Purpose = keyof typeof LABELS;

/**
 * Base64url without padding, which is what every value here is stored and transmitted as.
 * `=` is not URL-safe and `+`/`/` are not cookie-safe, so the standard alphabet would have
 * needed escaping at both boundaries.
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
 * The key is imported per call. That is deliberate rather than lazy: a `CryptoKey` cached
 * at module scope would outlive the request that created it, which is the same rule
 * `db/src/index.ts` states for the Drizzle client and the same reason —
 * `scripts/check-source-rules.mjs` only watches for Drizzle clients, so nothing would
 * catch this one. Importing a 32-byte HMAC key is arithmetic, not I/O.
 */
export async function sign(
  secret: string,
  purpose: Purpose,
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
 * The stored form of a One-Time Code.
 *
 * The shelter id is inside the message, so a hash lifted out of one row cannot be replayed
 * against another — which matters more here than it looks, because the plaintext space is
 * a million values. A shelter-scoped keyed hash is what makes that space unsearchable
 * without the key; an unkeyed SHA-256 of six digits is a rainbow table you could build on a
 * laptop.
 */
export function hashOneTimeCode(
  secret: string,
  shelterId: string,
  code: string,
): Promise<string> {
  return sign(secret, "code", `${shelterId}:${code}`);
}

/**
 * The stored form of a client IP. A fingerprint and not the address: the ledger answers
 * "how many requests from this caller" and needs nothing else, so it holds the answer
 * rather than the identifier (ADR 0010's posture on Do-Not-Contact).
 */
export function hashIp(secret: string, ip: string): Promise<string> {
  return sign(secret, "ip", ip);
}

/**
 * A uniformly random {@link ONE_TIME_CODE_DIGITS}-digit code, left-padded, as a string.
 *
 * Rejection sampling rather than `% 1_000_000`, which is the reflex and is biased: 2^32 is
 * not a multiple of a million, so the low 967,296 codes would come up marginally more often
 * than the rest. The bias is tiny and the fix is four lines, and a *credential* generator is
 * the wrong place to accept a known statistical flaw — it is the one function here whose
 * output an attacker gets to guess at.
 *
 * A string and not a number, because `012345` is a valid code and `12345` is not the same
 * one. The padding is part of the value.
 */
export function generateOneTimeCode(): string {
  // The largest multiple of the code space that fits in a uint32. Draws at or above it are
  // discarded, which is what removes the bias; each draw rejects with probability < 1/5000.
  const ceiling = Math.floor(0x1_0000_0000 / ONE_TIME_CODE_SPACE) * ONE_TIME_CODE_SPACE;
  const buffer = new Uint32Array(1);
  let draw: number;
  do {
    crypto.getRandomValues(buffer);
    draw = buffer[0]!;
  } while (draw >= ceiling);
  return String(draw % ONE_TIME_CODE_SPACE).padStart(ONE_TIME_CODE_DIGITS, "0");
}

/**
 * The opaque handle the browser holds while it waits for its code: 32 random bytes as
 * base64url.
 *
 * Unguessable rather than merely unique, because possession of one plus six digits is a
 * session. It exists so the submitted address never has to travel with the code — see
 * `oneTimeCodes.requestToken` in `db/src/schema.ts` for why that is a requirement and not a
 * convenience.
 */
export function generateRequestToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Compare two base64url digests without leaking, through timing, how far along they first
 * differ.
 *
 * `===` on strings short-circuits at the first differing character. For a *keyed* hash that
 * is a weak oracle — an attacker cannot choose the digest they are aiming at without the
 * key — but this is the comparison that stands between a guessed code and a session, and
 * writing the constant-time form costs three lines. Length is compared first and in the
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
