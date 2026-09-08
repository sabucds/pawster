/**
 * Request a One-Time Code.
 *
 * The one unauthenticated endpoint that can spend money, and the one whose *response* is as
 * much of the specification as its behaviour. ADR 0008 requires it to answer identically
 * whether or not an address is registered, or it becomes a shelter-enumeration oracle — so
 * every branch below converges on the same three responses, and which one you get never
 * depends on the address you submitted.
 *
 * An action endpoint rather than a page, which is what keeps ADR 0013's promise that
 * "sign-in adds no server-rendered route": the form that posts here is prerendered and
 * costs no Worker invocation, and the Worker runs on the post.
 *
 * ## What "identically" does and does not cover
 *
 * Stated exactly, because the loose version of this claim is how the oracle gets back in.
 *
 * **The response bytes carry no signal.** Status, `Location` and every cookie attribute are
 * fixed; the only varying part is a 32-byte random token that is equally random for a
 * registered address, so it distinguishes nothing. A failed send is caught below for the
 * same reason — an uncaught throw would have made a 500 the tell.
 *
 * **The response *timing* still does, and is not fixed here.** Only the registered branch
 * upserts a code and awaits Resend, so it answers hundreds of milliseconds later. Closing
 * that means either sending the mail after responding — which needs a `waitUntil` the Astro
 * adapter no longer exposes — or padding every response to a fixed floor, which spends the
 * Worker CPU ADR 0007 is trying not to spend. Neither is done, so the honest statement is
 * that this endpoint resists *reading* the answer and not *timing* it. Recorded rather than
 * quietly assumed away, and worth revisiting whenever the adapter grows a way to defer work
 * past the response.
 */

import { createDb } from "@pawster/db";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { generateRequestToken, hashIp } from "../../../lib/auth/crypto.ts";
import { sendOneTimeCodeEmail } from "../../../lib/auth/mail.ts";
import {
  ONE_TIME_CODE_TTL_MS,
  SIGN_IN_IP_REQUEST_LIMIT,
  refuseMail,
} from "../../../lib/auth/policy.ts";
import { parseCodeRequest } from "../../../lib/auth/registration.ts";
import { signInCookieHeader } from "../../../lib/auth/session.ts";
import {
  countIpRequests,
  findShelterByEmail,
  issueOneTimeCode,
  readMailBudgetUsage,
  recordSignInRequest,
} from "../../../lib/auth/store.ts";
import { clientIp } from "../../../lib/client-ip.ts";

export const prerender = false;

/** Where a shelter goes to type the code it has just been sent — or has not. */
const CODE_FORM = "/refugios/entrar/codigo";

/** Where a shelter goes when the platform has no mail left to spend today. */
const TRY_LATER = "/refugios/entrar/espera";

/**
 * Where a caller goes when it is the one asking too often.
 *
 * A different page from {@link TRY_LATER}, because they are different facts and the ceiling
 * page's words are false about this one — it says the platform's daily mail is gone and that
 * the caller did nothing, and neither is true of a rate-limited caller. Both reveal nothing
 * about any address, which is what lets either exist at all.
 */
const TOO_MANY = "/refugios/entrar/demasiados";

/**
 * The success response, and the only one that carries anything.
 *
 * The token names the outstanding code without naming the address, so this response can be
 * produced for an address that belongs to nobody — in which case the token is minted and
 * nothing is stored, and the code form will find no row for it. That is what makes the two
 * cases indistinguishable from outside.
 */
function codeFormResponse(requestToken: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: CODE_FORM,
      "set-cookie": signInCookieHeader(requestToken, ONE_TIME_CODE_TTL_MS),
    },
  });
}

/**
 * The refusal, which is deliberately *not* address-specific.
 *
 * Only the global ceiling and the IP limit reach here, and neither is a fact about the
 * submitted address: the ceiling is platform-wide state, and the IP limit is a fact about
 * the caller. A per-address refusal must never land here — telling a caller it is inside a
 * five-minute cooldown confirms the address exists, which is the whole thing this endpoint
 * is built not to do. Those two are refused silently, with the success response.
 *
 * The two that do reach here take *different* pages, because they are different facts and
 * one page cannot be honest about both. See {@link TOO_MANY}.
 */
function refusalResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);
  const now = new Date();
  const ipHash = await hashIp(env.SIGN_IN_SECRET, clientIp(request));

  /**
   * The IP limit is checked first, and a caller already over it has **no ledger row
   * written**. That ordering is what bounds the endpoint: every other path here appends a
   * row, so without an early exit an unauthenticated caller could make the platform write
   * to D1 without limit. Over the limit, the cost of a request is one indexed `COUNT(*)`.
   */
  if ((await countIpRequests(db, ipHash, now)) >= SIGN_IN_IP_REQUEST_LIMIT) {
    return refusalResponse(TOO_MANY);
  }

  const accountEmail = parseCodeRequest(await request.formData());
  /**
   * A malformed address and a well-formed stranger are the same thing from here on. Both
   * give `null`, both get the success response, and neither is told which it was.
   */
  const shelter =
    accountEmail === null ? null : await findShelterByEmail(db, accountEmail);

  const usage = await readMailBudgetUsage(db, shelter?.id ?? null, now);
  const refusal = refuseMail(usage, now);

  /**
   * The global ceiling is the only refusal a shelter is told about, because it is the only
   * one that is not about anything the shelter did — and because the honest answer to "the
   * platform is out of mail" is to say so rather than to let a shelter believe a code is on
   * its way. `refuseMail` tests it first for exactly this reason.
   *
   * The row is still appended: a request that was refused is a request that happened, and
   * the IP limit counts it.
   */
  if (refusal === "global-ceiling") {
    await recordSignInRequest(
      db,
      { shelterId: shelter?.id ?? null, ipHash, mailSent: false },
      now,
    );
    return refusalResponse(TRY_LATER);
  }

  if (shelter === null || refusal !== null) {
    /**
     * Nothing to send, or nothing left in this address's own allowance. A token is minted
     * anyway and points at no code, so the response is the same shape and the same length
     * as the one a registered shelter gets, and the code form's answer to it will be the
     * same "that code did not work" a wrong guess gets.
     */
    await recordSignInRequest(
      db,
      { shelterId: shelter?.id ?? null, ipHash, mailSent: false },
      now,
    );
    return codeFormResponse(generateRequestToken());
  }

  const issued = await issueOneTimeCode(db, env.SIGN_IN_SECRET, shelter.id, now);

  /**
   * The ledger row is written **before** the send, so a Resend failure still costs this
   * address one of its five. The other way round, a caller could retry without limit against
   * an endpoint whose entire purpose is to be rate-limited.
   */
  await recordSignInRequest(
    db,
    { shelterId: shelter.id, ipHash, mailSent: true },
    now,
  );

  /**
   * A failed send must not change the response, and this `catch` is the whole reason the
   * identical-response rule actually holds.
   *
   * Without it, `sendOneTimeCodeEmail` throwing on a Resend non-2xx becomes an unhandled
   * error and the shelter gets a 500 — while an unregistered address, which never reaches
   * this line, still gets its 303. That difference is a working enumeration oracle: submit
   * an address during any Resend outage and the status code tells you whether it is
   * registered. It is the exact failure ADR 0008 forbids, arriving through the one path
   * nobody thinks of as a branch.
   *
   * So the response is the same and the failure is logged instead. The shelter is not left
   * guessing: the code page it lands on already tells it to check the spelling and offers to
   * send another, which is the correct advice whether the address was wrong or Resend was
   * down. The ledger row is already written, so the attempt still counts against this
   * address — a retry loop must not be free just because the send failed.
   */
  try {
    await sendOneTimeCodeEmail(env, {
      // Non-null by construction: `shelter` is only non-null when an address was parsed.
      to: accountEmail!,
      code: issued.code,
    });
  } catch (error) {
    // `observability` is enabled in `web/wrangler.jsonc`, so this reaches the dashboard.
    // The code itself is never logged; it is a live credential.
    console.error("sign-in code send failed", {
      shelterId: shelter.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return codeFormResponse(issued.requestToken);
};
