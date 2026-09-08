/**
 * The token that lets Cloudflare's image pipeline read one original, and lets nothing else
 * read anything.
 *
 * [ADR 0012](../../../../docs/adr/0012-derivatives-are-generated-once-at-upload.md) sets up
 * an apparent contradiction and then resolves it. `cf.image` needs its source reachable
 * **by URL**, because the pipeline resolves that URL outside our isolate — which is also
 * why a Worker's own assets are unreachable to it by plain `fetch` and `cf.image` is
 * exempt. But the originals bucket "must never be public", since "a volunteer photographing
 * a foster animal indoors embeds that home's coordinates" in EXIF a derivative does not
 * carry. The resolution is this file: a Worker route that checks a capability and only then
 * serves the bytes is reachable by the pipeline and by nobody else. Measured both ways in
 * issue #34 — 1 ms of CPU through the gated route, and **403** for a bad token, surfacing
 * to the caller as `cf-resized: err=9408`.
 *
 * This is [ADR 0008](../../../../docs/adr/0008-confirmation-is-a-capability-not-a-session.md)'s
 * shape, and the properties that make it a capability rather than a session are worth
 * naming: it authorises **one key** and not an account, it carries its own expiry, it names
 * no shelter, and holding it grants nothing but those bytes for those minutes.
 *
 * ## Why this is the platform's third secret
 *
 * `ORIGINAL_SECRET`, and not a domain-separated use of one of the two that exist. ADR 0013
 * argues for few secrets — "every additional secret is another thing `wrangler secret put`
 * has to be told about and another way a deploy can be half-configured" — and that argument
 * is real. What outweighs it is that this is the only key in the platform **presented by
 * something outside it**: the token travels in a URL to Cloudflare's image pipeline, and
 * lands in whatever the pipeline logs. Rotating it costs the in-flight uploads of the next
 * few minutes. Rotating `SESSION_SECRET` signs every shelter on the platform out. Keys with
 * that different a blast radius should not share a rotation.
 *
 * The precedent is already here: `digest/` holds `UNSUBSCRIBE_SECRET` separately for the
 * same reason, one secret per thing that can be revoked on its own.
 */

import { digestsEqual, sign } from "../auth/crypto.ts";

export interface OriginalSecrets {
  readonly ORIGINAL_SECRET: string;
}

/**
 * How long a minted token is good for.
 *
 * Five minutes, which is a generous ceiling on the four transforms of one upload and a
 * short one on anything else. It is not the security boundary — the signature is, and it
 * covers the key, so a leaked token reaches exactly the object it was minted for. What the
 * expiry bounds is how long a token found in a log is worth anything, and for an object
 * that is deleted after seven days regardless, that is the whole exposure.
 */
export const ORIGINAL_TOKEN_TTL_MS = 5 * 60_000;

/**
 * A token for one original key: its expiry, then a signature over both.
 *
 * The expiry is inside the signed message as well as beside it, which is the difference
 * between an expiry and a suggestion — otherwise the holder edits the number in front of
 * the dot and the signature still verifies.
 */
export async function mintOriginalToken(
  secrets: OriginalSecrets,
  key: string,
  now: Date,
): Promise<string> {
  const expiresAt = now.getTime() + ORIGINAL_TOKEN_TTL_MS;
  const signature = await sign(
    secrets.ORIGINAL_SECRET,
    "original",
    `${key}:${expiresAt}`,
  );
  return `${expiresAt}.${signature}`;
}

/**
 * Whether this token authorises this key, right now.
 *
 * `false` is every failure — absent, malformed, expired, signed for a different key, signed
 * with a different secret — and the caller answers 403 to all of them without saying which.
 * Distinguishing "expired" from "forged" would tell a caller holding a stale token that it
 * once held a real one, and there is nobody who needs to know that: the only legitimate
 * holder is the image pipeline, which is handed a fresh token and never retries an old one.
 */
export async function verifyOriginalToken(
  secrets: OriginalSecrets,
  key: string,
  token: string | null,
  now: Date,
): Promise<boolean> {
  if (!token) return false;

  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt)) return false;

  const expected = await sign(
    secrets.ORIGINAL_SECRET,
    "original",
    `${key}:${expiresAt}`,
  );
  // The signature is checked before the clock, so a forged token and an expired one take
  // the same work and neither is distinguishable by how long the answer took.
  if (!digestsEqual(expected, token.slice(dot + 1))) return false;

  return now.getTime() < expiresAt;
}
