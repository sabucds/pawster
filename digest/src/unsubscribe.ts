/**
 * The signed unsubscribe link.
 *
 * CONTEXT.md: a Subscription is "managed entirely through signed links; never behind a
 * login", and a Subscriber "has no account and no password" — so the link *is* the
 * credential, and an unsigned `/unsubscribe/<subscriberId>` would let anyone who can guess
 * an id unsubscribe a stranger. The id is the only thing the digest knows about a
 * recipient, which makes guessability the whole risk.
 *
 * ADR 0008's capability rule applies with one deliberate difference: a confirmation link
 * may never mutate on `GET`, because link scanners would manufacture the freshness signal
 * the listing depends on. Unsubscribe is the opposite trade — ADR 0009 requires a `GET`
 * page that unsubscribes on load, since a one-click header that needs a second click is
 * not one-click — and a scanner that unsubscribes someone is a nuisance, not a corruption
 * of platform state, and is reversible by opting in again.
 */

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, subscriberId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    await crypto.subtle.sign("HMAC", key, encoder.encode(subscriberId)),
  );
}

/**
 * `<origin>/unsubscribe/<subscriberId>.<signature>`. The origin is configuration rather
 * than a literal because the apex lives outside Cloudflare and can move without a code
 * change (ADR 0014).
 */
export async function unsubscribeUrl(
  config: { readonly SITE_ORIGIN: string; readonly UNSUBSCRIBE_SECRET: string },
  subscriberId: string,
): Promise<string> {
  const signature = await sign(config.UNSUBSCRIBE_SECRET, subscriberId);
  return `${config.SITE_ORIGIN.replace(/\/+$/, "")}/unsubscribe/${subscriberId}.${signature}`;
}

/**
 * The other half, and the reason the signature is worth anything: it exists so the route
 * that serves the link can reject a forged one, and so a test can prove a tampered token
 * is rejected rather than taking the signing on trust.
 *
 * Compares in constant time — a leaky compare on a 32-byte MAC is the one shortcut that
 * turns a signed link back into a guessable one.
 */
export async function verifyUnsubscribeToken(
  config: { readonly UNSUBSCRIBE_SECRET: string },
  token: string,
): Promise<string | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const subscriberId = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  const expected = await sign(config.UNSUBSCRIBE_SECRET, subscriberId);

  if (presented.length !== expected.length) return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0 ? subscriberId : null;
}
