/**
 * The Session cookie: three facts, one signature, and no row anywhere.
 *
 * A Session is "a signed cookie carrying the shelter id, an issued-at and a session epoch,
 * validated against a `sessionEpoch` column on the shelter row. There is no password, no
 * OAuth, and no session table" (ADR 0013). This module is the codec for that cookie and
 * nothing else: it reads and writes the header, and it knows nothing about D1. What the
 * epoch is checked *against* lives in `guard.ts`, because that is where the shelter row is.
 *
 * The cookie is signed rather than encrypted. Its three fields are a shelter's own id, a
 * timestamp and a small integer — nothing an adopter could not learn by reading the site —
 * so confidentiality buys nothing and integrity is the whole requirement.
 */

import { digestsEqual, sign, toBase64Url } from "./crypto.ts";
import type { SessionClaims } from "./policy.ts";
import { SESSION_TTL_MS } from "./policy.ts";

/**
 * The Session cookie's name.
 *
 * `__Host-` was the tempting prefix and is wrong here: it pins the cookie to the exact host
 * that set it and forbids a `Domain` attribute, which is right, but the test seam and local
 * `wrangler dev` both serve over hosts where the prefix's `Secure` requirement cannot hold.
 * The attributes below assert the same properties directly.
 */
export const SESSION_COOKIE = "pawster_session";

/**
 * The name of the short-lived cookie that carries a code request's opaque token from the
 * endpoint that mints it to the endpoint that spends it. Not a session and never treated as
 * one.
 */
export const SIGN_IN_COOKIE = "pawster_sign_in";

/**
 * The whole site, because the Session is read from `/refugios/panel`, from
 * `/api/refugios/salir`, and from every publishing route still to come — which do not share
 * a common prefix narrower than this.
 */
export const SESSION_PATH = "/";

/**
 * `/api/refugios`, and getting this wrong is a bug no test in this repo can see.
 *
 * A cookie is sent only where RFC 6265 §5.1.4's path-match holds: the cookie's path must be
 * a **prefix of the request path**. This cookie was first scoped to `/refugios`, on the
 * reasoning that it belonged to the code form — and `/refugios` is not a prefix of
 * `/api/refugios/sesion`, which is the *only* thing that ever reads it. A browser would
 * therefore never have sent it, and every sign-in on the platform would have collapsed to
 * "ese código no sirvió" with nothing in any log to explain why.
 *
 * The suite could not catch it, and that is worth stating rather than treating as bad luck:
 * `web/test/shelter-access.test.ts` sets the `cookie` header by hand, so it exercises the
 * server's parsing and never the browser's scoping rule. `docs/testing-seams.md` already
 * says the seam cannot see this class of thing. `session-cookie.test.ts` asserts the
 * relationship directly instead — that the path is a prefix of the endpoint's path — which
 * is the only form of the check available without a real browser.
 *
 * `/api/refugios` rather than the exact endpoint path: the minting endpoint
 * (`/api/refugios/codigo`) has to be able to clear it too, and both live under this prefix.
 * It stays off `/refugios/*`, so the prerendered pages never carry it.
 */
export const SIGN_IN_PATH = "/api/refugios";

/**
 * The wire form: `base64url(JSON) "." base64url(HMAC)`.
 *
 * JSON rather than a delimiter-joined string, so that no field's value can ever be confused
 * for a separator. The keys are one letter each because a cookie is sent on every request to
 * the origin and the names carry no information the parser needs — the shape is fixed here
 * and nowhere else.
 */
interface Payload {
  /** Shelter id. */
  s: string;
  /** Issued at, epoch milliseconds. */
  i: number;
  /** The `shelters.sessionEpoch` this cookie was minted under. */
  e: number;
}

function encodePayload(claims: SessionClaims): string {
  const payload: Payload = {
    s: claims.shelterId,
    i: claims.issuedAt.getTime(),
    e: claims.epoch,
  };
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodePayload(encoded: string): SessionClaims | null {
  let json: string;
  try {
    // `atob` rejects the base64url alphabet, so the two substitutions are undone first.
    // Padding is restored to a multiple of four; `atob` requires it even though the encoder
    // strips it.
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    json = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  // Validated field by field rather than cast. The signature already proves we minted this
  // payload, so a malformed one is our own bug or an old format rather than an attack — but
  // a cast would turn either into a `TypeError` deep in a handler instead of a signed-out
  // shelter, which is the recoverable answer.
  if (typeof parsed !== "object" || parsed === null) return null;
  const { s, i, e } = parsed as Partial<Payload>;
  if (typeof s !== "string" || s.length === 0) return null;
  if (typeof i !== "number" || !Number.isFinite(i)) return null;
  if (typeof e !== "number" || !Number.isInteger(e)) return null;

  return { shelterId: s, issuedAt: new Date(i), epoch: e };
}

/**
 * Mint a cookie value for these claims. The caller decides the issued-at, which is what
 * lets a sliding refresh re-issue the same shelter and epoch under a new timestamp without
 * this module needing a clock.
 */
export async function encodeSession(
  secret: string,
  claims: SessionClaims,
): Promise<string> {
  const payload = encodePayload(claims);
  return `${payload}.${await sign(secret, "session", payload)}`;
}

/**
 * Recover the claims from a cookie value, or `null` if the signature does not hold.
 *
 * **This proves authorship and nothing else.** Whether the claims are still a session —
 * whether the epoch is current and the ninety days have not run out — is
 * `refuseSession()`'s question, asked in `guard.ts` where the shelter row is available. A
 * caller that treats a non-null return as "signed in" has skipped revocation.
 */
export async function decodeSession(
  secret: string,
  cookieValue: string,
): Promise<SessionClaims | null> {
  const separator = cookieValue.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = await sign(secret, "session", payload);
  if (!digestsEqual(signature, expected)) return null;

  return decodePayload(payload);
}

/**
 * Read one cookie out of a request.
 *
 * Hand-parsed because the Workers runtime offers no cookie API and pulling in a parser for
 * a `; `-separated list would be a dependency for two lines. Only the *first* occurrence of
 * a name is honoured: a request carrying the header twice is either a client bug or an
 * attempt to shadow the real value, and taking the first is the same choice browsers make.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * The one place a `Set-Cookie` is built, for both cookies and for both setting and clearing.
 *
 * Written once rather than four times because a browser matches a replacement cookie on
 * name, path and the security attributes: get one of them wrong in the clearing header and
 * the original is left in place while the response looks like it worked. Four hand-written
 * copies of the same list is four chances at that, and the two that have to agree exactly
 * are the two furthest apart.
 *
 * `SameSite=Lax` rather than `Strict`, because ADR 0008's confirmation nudges are links in
 * an inbox: under `Strict` a shelter arriving from its own email would land signed out,
 * having done nothing wrong. `Lax` withholds the cookie from cross-site POSTs, which is the
 * half that matters — every mutating endpoint here is a POST, and Astro's own
 * `security.checkOrigin` backstops the one that takes no cookie at all.
 */
function cookieHeader(
  name: string,
  value: string,
  path: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * The `Set-Cookie` for a live session.
 *
 * `Max-Age` matches {@link SESSION_TTL_MS} so the browser and the server agree on when the
 * ninety days are up. The server's check is the authority; this only saves the round trip.
 */
export function sessionCookieHeader(value: string): string {
  return cookieHeader(
    SESSION_COOKIE,
    value,
    SESSION_PATH,
    Math.floor(SESSION_TTL_MS / 1000),
  );
}

/** The `Set-Cookie` that ends a session in the browser. */
export function clearSessionCookieHeader(): string {
  return cookieHeader(SESSION_COOKIE, "", SESSION_PATH, 0);
}

/**
 * The `Set-Cookie` carrying a code request's opaque token.
 *
 * Its lifetime is the code's: a token that outlived the code it names would be a handle to
 * nothing. It holds no address — see `oneTimeCodes.requestToken` in `db/src/schema.ts` — and
 * its path is {@link SIGN_IN_PATH}, which is where the endpoint that reads it actually lives.
 */
export function signInCookieHeader(token: string, ttlMs: number): string {
  return cookieHeader(
    SIGN_IN_COOKIE,
    token,
    SIGN_IN_PATH,
    Math.floor(ttlMs / 1000),
  );
}

export function clearSignInCookieHeader(): string {
  return cookieHeader(SIGN_IN_COOKIE, "", SIGN_IN_PATH, 0);
}
