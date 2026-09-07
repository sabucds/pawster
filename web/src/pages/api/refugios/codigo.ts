/**
 * Request a One-Time Code.
 *
 * The one unauthenticated write endpoint on the platform, and the one whose *response* is
 * as much of the specification as its behaviour. ADR 0008 requires it to answer identically
 * whether or not an address is registered, or it becomes a shelter-enumeration oracle — so
 * every branch below converges on the same two responses, and which one you get never
 * depends on the address you submitted.
 *
 * An action endpoint rather than a page, which is what keeps ADR 0013's promise that
 * "sign-in adds no server-rendered route": the form that posts here is prerendered and
 * costs no Worker invocation, and the Worker runs on the post.
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

export const prerender = false;

/** Where a shelter goes to type the code it has just been sent — or has not. */
const CODE_FORM = "/refugios/entrar/codigo";

/** Where a shelter goes when the platform has no mail left to spend today. */
const TRY_LATER = "/refugios/entrar/espera";

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
 * is built not to do.
 */
function tryLaterResponse(): Response {
  return new Response(null, { status: 303, headers: { location: TRY_LATER } });
}

/**
 * The caller's address, as a bucket key rather than as an identity.
 *
 * Read from the header directly instead of through `Astro.clientAddress`, which throws when
 * the adapter cannot supply one — an exception on the sign-in path is a worse failure than a
 * coarse bucket. The fallback lumps every request with no `CF-Connecting-IP` into one
 * bucket, which is the conservative direction: unattributable traffic shares a single
 * allowance rather than each getting a fresh one.
 */
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unattributed";
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
    return tryLaterResponse();
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
    return tryLaterResponse();
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

  await sendOneTimeCodeEmail(env, {
    // Non-null by construction: `shelter` is only non-null when an address was parsed.
    to: accountEmail!,
    code: issued.code,
  });

  return codeFormResponse(issued.requestToken);
};
