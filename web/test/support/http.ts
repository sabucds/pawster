/**
 * Talking to the Worker the way a browser does: one `FormData` post, one `GET`, and reading a
 * cookie back off a response.
 *
 * Extracted from `shelter.ts` when the subscriber suite arrived, because none of it is about
 * shelters — it is about Astro's CSRF check and about `redirect: "manual"`, and both of those
 * are properties of every form this platform serves. A second copy would have been a second
 * place to remember that a form post without an `Origin` header is a 403.
 */

import { SELF } from "cloudflare:test";

export const ORIGIN = "https://pawster.test";

/** A distinct IP per call, so the per-IP request limit cannot leak between tests. */
let ip = 0;
const nextIp = () => `203.0.113.${++ip % 250}`;

export interface PostOptions {
  cookie?: string;
  ip?: string;
  /** Overridden only by the test that checks a cross-site post is refused. */
  origin?: string;
}

/**
 * `redirect: "manual"` throughout, because the redirect *is* the response under test: which
 * page a code request sends you to is the whole of ADR 0008's identical-response rule, and
 * whether a profile save answers 303 or 200 is how a refusal is told from a success.
 */
export function post(
  path: string,
  fields: Record<string, string | readonly string[]>,
  options: PostOptions = {},
): Promise<Response> {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value as string]) {
      body.append(name, item);
    }
  }
  /**
   * `Origin` is sent because a browser sends it on a form post, and Astro's built-in
   * `security.checkOrigin` refuses a same-site form submission without it with a 403. That
   * check is a CSRF defence worth keeping on these endpoints, so the tests match what a
   * browser does rather than turning it off.
   */
  const headers = new Headers({
    "cf-connecting-ip": options.ip ?? nextIp(),
    origin: options.origin ?? ORIGIN,
  });
  if (options.cookie) headers.set("cookie", options.cookie);

  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    body,
    headers,
    redirect: "manual",
  });
}

export function get(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    headers: cookie ? { cookie } : undefined,
    redirect: "manual",
  });
}

/** One `Set-Cookie` off a response, reduced to its `name=value` for sending back. */
export function cookieFrom(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

