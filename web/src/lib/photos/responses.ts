/**
 * How a refusal reaches the browser: one status and one machine-readable reason per
 * `UploadRefusalReason`, and nothing else.
 *
 * The mapping is here rather than at each endpoint because three of them refuse for the same
 * reasons, and a status chosen twice is a status that will eventually be chosen differently.
 * The reason string travels as well as the status: `413` alone cannot tell a form whether to
 * say "that photo is too big" or "that photo is too many megapixels", and both are things a
 * shelter can act on.
 *
 * These endpoints answer JSON rather than redirecting, unlike the sign-in ones. The
 * difference is who is asking: sign-in is a prerendered `<form>` post, so a redirect is the
 * whole response, while a photo upload is `fetch` from a page that has to keep its other
 * five photos on screen and report which one failed.
 */

import type { UploadRefusal, UploadRefusalReason } from "@pawster/domain";

/**
 * The status each refusal answers with.
 *
 * `507 Insufficient Storage` for both platform-wide limits is the only one worth arguing
 * about. It reads as a storage error and the transformation budget is not storage — but the
 * alternatives are worse: `429` invites a retry that will fail identically for the rest of
 * the month, and `503` invites one in a few seconds. `507` is the only 5xx that says "this
 * is a resource I have run out of, and it is not your request's fault", which is exactly the
 * fact a shelter needs and exactly what the retry advice depends on.
 */
const STATUSES: Readonly<Record<UploadRefusalReason, number>> = {
  // The session is gone rather than forbidden: a shelter starts a new one.
  "session-expired": 410,
  "photo-limit-reached": 409,
  "duplicate-photo": 409,
  "unsupported-type": 415,
  "file-too-large": 413,
  "image-too-large": 413,
  "storage-exhausted": 507,
  "transformation-budget-exhausted": 507,
};

/** Attach a slid session cookie to a response, if `guard.ts` produced one. */
export function withRefreshedCookie(
  response: Response,
  refreshedCookie: string | null,
): Response {
  if (!refreshedCookie) return response;
  response.headers.append("set-cookie", refreshedCookie);
  return response;
}

/**
 * A refusal, as JSON.
 *
 * `limit` and `actual` are passed through from `domain/` untouched. They are what turns a
 * status into a sentence — "12 MB" and "the 40 MB you sent" — and the platform holds both
 * numbers already, so making the form guess either of them would be inventing a second
 * source of truth for a limit.
 */
export function refusalResponse(
  refusal: UploadRefusal,
  refreshedCookie: string | null = null,
): Response {
  return withRefreshedCookie(
    Response.json(
      {
        refused: refusal.reason,
        ...(refusal.limit === undefined ? {} : { limit: refusal.limit }),
        ...(refusal.actual === undefined ? {} : { actual: refusal.actual }),
      },
      { status: STATUSES[refusal.reason] },
    ),
    refreshedCookie,
  );
}
