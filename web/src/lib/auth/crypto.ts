/**
 * The primitives shelter access is built from: one keyed hash, one unbiased random code,
 * one opaque token, and a comparison that does not leak where two strings first differ.
 *
 * All of it is WebCrypto, which the Workers runtime supplies as a global — no `node:crypto`
 * and no dependency. `HMAC-SHA256` is the same primitive ADR 0010 chose for Do-Not-Contact,
 * and ADR 0013 calls it "cheap enough to ignore the CPU ceiling", unlike the password
 * hashing that ceiling ruled out.
 *
 * ## One labels table, several keys — and it now lives in `domain/`
 *
 * `SIGN_IN_SECRET` keys the code hash and the sign-in IP fingerprint; `SESSION_SECRET` signs
 * the cookie. Two rather than four on the shelter path, because every additional secret is
 * another thing `wrangler secret put` has to be told about and another way a deploy can be
 * half-configured — and a key earns its own existence only by having a different blast
 * radius, which `ORIGINAL_SECRET` (ADR 0012), `ADMIN_LINK_SECRET` (ADR 0019),
 * `DO_NOT_CONTACT_PEPPER` (ADR 0010) and `SUBSCRIBER_LINK_SECRET` all do and each of their
 * own files argues.
 *
 * Reusing one key for two purposes is only safe if the two message spaces cannot overlap, so
 * every message is **domain-separated by a literal label** that no caller chooses. The table
 * of those labels used to be here, and the property it guarantees is that *no two messages
 * anywhere in the platform can be read as each other* — which a single list makes checkable
 * by reading one screen.
 *
 * Issue #62 moved that table, and the `sign()` over it, to
 * [`@pawster/domain`'s `keyed-hash.ts`](../../../../../domain/src/keyed-hash.ts), because a
 * manage link is built in `digest/` and verified in `web/` and `digest/` cannot import `web/`.
 * Keeping the table here would have forced a second one into `digest/`, which is the exact
 * outcome the guarantee rules out. It is re-exported below so every call site in `web/` is
 * unchanged and there is still one place a label is written down.
 */

import { sign, toBase64Url } from "@pawster/domain";
import { ONE_TIME_CODE_DIGITS, ONE_TIME_CODE_SPACE } from "./policy.ts";

/**
 * The keyed hash, its base64url encoding and its constant-time compare, re-exported from the
 * one package all three consumers share. See this module's comment for why they moved.
 */
export { digestsEqual, sign, toBase64Url } from "@pawster/domain";

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
