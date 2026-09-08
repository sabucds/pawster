/**
 * A 303 to a page, carrying nothing else.
 *
 * One function because both unauthenticated form endpoints answer this way and for the same
 * reason, not merely with the same code: **which page you land on is the whole of the
 * response**, so the body has to be empty and every header has to be fixed. A refusal and a
 * success differ in one URL and in nothing a caller can measure — that is what makes ADR
 * 0008's identical-response rule checkable by reading the four constants at the top of each
 * endpoint.
 *
 * 303 rather than 302, so the browser follows with a `GET`. A 302 leaves the method to the
 * client, and a re-`POST` to a refusal page is a second write on a path built to be
 * rate-limited.
 *
 * The one caller that needs more — sign-in's success, which must also set the cookie naming
 * the outstanding code — builds its own response rather than taking a `headers` parameter
 * here. A parameter would have made this function the place a cookie *could* vary by branch,
 * which is exactly the thing the endpoint is asserting it does not.
 */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
