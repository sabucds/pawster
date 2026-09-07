/**
 * Check a typed code and begin a Session — and end one.
 *
 * Every way this can fail collapses onto **one** response: a wrong code, an expired code, a
 * code whose five attempts are gone, a superseded code, a token that names nothing, and a
 * token minted for an address that belongs to nobody all send the shelter to the same page
 * with the same words. That is not laziness about error messages; distinguishing them is
 * precisely how a code form becomes an oracle. "Ese código no sirvió" is also the *complete*
 * answer for a shelter, whose next move — ask for another one — is the same in every case.
 */

import { createDb } from "@pawster/db";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { digestsEqual, hashOneTimeCode } from "../../../lib/auth/crypto.ts";
import { beginSession } from "../../../lib/auth/guard.ts";
import {
  ONE_TIME_CODE_DIGITS,
  isCodeExhausted,
  refuseOneTimeCode,
} from "../../../lib/auth/policy.ts";
import { parseSubmittedCode } from "../../../lib/auth/registration.ts";
import {
  SIGN_IN_COOKIE,
  clearSignInCookieHeader,
  readCookie,
} from "../../../lib/auth/session.ts";
import {
  deleteOneTimeCode,
  findCodeByRequestToken,
  findShelterEpoch,
  recordFailedAttempt,
} from "../../../lib/auth/store.ts";

export const prerender = false;

/** Where a shelter lands once it is in. */
const PANEL = "/refugios/panel";

/** The single failure page, reached by every refusal above. */
const REFUSED = "/refugios/entrar/codigo-invalido";

/**
 * The one refusal response.
 *
 * It clears the sign-in cookie only when the code is genuinely finished — dead or gone — so
 * that a shelter who mistyped one digit can go back and try again on the same code, which
 * is what the five-attempt ceiling is for. Clearing it on every wrong guess would have made
 * the ceiling unreachable and turned every typo into a fresh email.
 */
function refusedResponse(clearToken: boolean): Response {
  const headers = new Headers({ location: REFUSED });
  if (clearToken) headers.set("set-cookie", clearSignInCookieHeader());
  return new Response(null, { status: 303, headers });
}

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);
  const now = new Date();

  const requestToken = readCookie(request, SIGN_IN_COOKIE);
  if (!requestToken) return refusedResponse(false);

  const submitted = parseSubmittedCode(
    await request.formData(),
    ONE_TIME_CODE_DIGITS,
  );
  /**
   * A malformed entry is refused **without touching `attemptsUsed`**. The ceiling exists to
   * bound *guesses* at a six-digit secret, and `12` is not a guess at one — counting it
   * would let a shelter that fat-fingered the field twice burn attempts it never spent on
   * the code.
   */
  if (submitted === null) return refusedResponse(false);

  const row = await findCodeByRequestToken(db, requestToken);
  // No row: the token names nothing, names a consumed code, or was minted for an address
  // that belongs to nobody. The three are indistinguishable here, which is the point.
  if (!row) return refusedResponse(true);

  const refusal = refuseOneTimeCode(row, now);
  if (refusal !== null) {
    // Dead either way, so it goes — and the daily purge is spared a row.
    await deleteOneTimeCode(db, row.shelterId);
    return refusedResponse(true);
  }

  const expected = await hashOneTimeCode(
    env.SIGN_IN_SECRET,
    row.shelterId,
    submitted,
  );
  if (!digestsEqual(expected, row.codeHash)) {
    const attemptsUsed = await recordFailedAttempt(
      db,
      row.shelterId,
      row.attemptsUsed,
    );
    /**
     * The fifth wrong guess retires the code here rather than leaving it to be refused on
     * the sixth. Both behave the same from outside, and deleting it means a stolen token
     * stops being worth holding the moment the code behind it is spent.
     */
    if (isCodeExhausted(attemptsUsed)) {
      await deleteOneTimeCode(db, row.shelterId);
      return refusedResponse(true);
    }
    return refusedResponse(false);
  }

  /**
   * The epoch is read *now* rather than taken from anything the browser sent, because it is
   * the one claim in the cookie that a shelter must not be able to choose. A cookie minted
   * under a stale epoch is refused by `guard.ts`; a cookie minted under the *current* epoch
   * is a session, so this read is what binds the new session to the revocation state as it
   * stands at sign-in.
   */
  const epoch = await findShelterEpoch(db, row.shelterId);
  if (epoch === null) return refusedResponse(true);

  /** Single use, expressed as absence: the row is gone, so the code cannot be replayed. */
  await deleteOneTimeCode(db, row.shelterId);

  const headers = new Headers({ location: PANEL });
  headers.append(
    "set-cookie",
    await beginSession(env, {
      shelterId: row.shelterId,
      issuedAt: now,
      epoch,
    }),
  );
  // The handle has done its job and is a bearer credential; it does not outlive the code.
  headers.append("set-cookie", clearSignInCookieHeader());

  return new Response(null, { status: 303, headers });
};

