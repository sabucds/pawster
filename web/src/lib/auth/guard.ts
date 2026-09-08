/**
 * Turning a cookie into a signed-in shelter, which is the one question every authenticated
 * route asks.
 *
 * Three steps, and skipping any of them is a security bug rather than an optimisation:
 *
 * 1. the signature holds, so we minted the payload (`session.ts`);
 * 2. the epoch in it still matches `shelters.sessionEpoch`, so it has not been revoked;
 * 3. the ninety days have not run out.
 *
 * Step 2 is the only one that touches the database, and it reads a row an authenticated
 * route was going to read anyway to render the publishing area — which is what ADR 0013
 * means by "revocation is one integer". Bumping that integer invalidates every live cookie
 * at once, with no session table to walk.
 */

import type { Database } from "@pawster/db";
import type { SessionClaims } from "./policy.ts";
import { refuseSession, shouldRefreshSession } from "./policy.ts";
import {
  SESSION_COOKIE,
  clearSessionCookieHeader,
  decodeSession,
  encodeSession,
  readCookie,
  sessionCookieHeader,
} from "./session.ts";
import { findShelterEpoch } from "./store.ts";

export interface AuthenticatedShelter {
  readonly shelterId: string;
  /**
   * A `Set-Cookie` value the caller must copy onto its response, or `null`.
   *
   * Present only when the cookie has aged past the refresh threshold. This is the sliding
   * part of a sliding session and it **performs no database write** — the same three facts
   * are re-signed under a new issued-at, so a shelter that keeps visiting keeps its session
   * indefinitely at a cost of one response header.
   *
   * Returned rather than applied, because this function does not own the response. A caller
   * that drops it does not break the session; it only declines to extend it, which is a
   * failure that heals on the next request.
   */
  readonly refreshedCookie: string | null;
}

export interface SessionSecrets {
  readonly SESSION_SECRET: string;
}

/**
 * The signed-in shelter, or `null`.
 *
 * `null` is every failure: no cookie, a forged one, one minted under a superseded epoch, one
 * older than ninety days, and one naming a shelter that no longer exists. The caller cannot
 * tell them apart and has no reason to — every one of them means "sign in again", and
 * reporting *which* would tell an attacker holding a stolen cookie whether the shelter had
 * revoked it.
 */
export async function authenticate(
  request: Request,
  db: Database,
  secrets: SessionSecrets,
  now: Date,
): Promise<AuthenticatedShelter | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return null;

  const claims = await decodeSession(secrets.SESSION_SECRET, cookie);
  if (!claims) return null;

  const currentEpoch = await findShelterEpoch(db, claims.shelterId);
  // A cookie naming a shelter that is not there: an id from a wiped database, or a row
  // deleted out from under a live session. Not a session either way.
  if (currentEpoch === null) return null;

  if (refuseSession(claims, currentEpoch, now) !== null) return null;

  const refreshedCookie = shouldRefreshSession(claims, now)
    ? sessionCookieHeader(
        await encodeSession(secrets.SESSION_SECRET, {
          shelterId: claims.shelterId,
          issuedAt: now,
          epoch: currentEpoch,
        }),
      )
    : null;

  return { shelterId: claims.shelterId, refreshedCookie };
}

/**
 * The `Set-Cookie` that begins a session, for the endpoint that has just checked a code.
 *
 * The epoch is passed in rather than read here, because the caller has just read the shelter
 * row to find the code and holds a fresher copy than a second query would return.
 */
export async function beginSession(
  secrets: SessionSecrets,
  claims: SessionClaims,
): Promise<string> {
  return sessionCookieHeader(await encodeSession(secrets.SESSION_SECRET, claims));
}

/** The `Set-Cookie` that ends one in the browser. */
export function endSession(): string {
  return clearSessionCookieHeader();
}
