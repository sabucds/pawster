/**
 * The one door into `pawster-originals`, and it opens for a capability rather than a
 * session.
 *
 * ADR 0012 needs two things that look incompatible: `cf.image` requires its source to be
 * reachable **by URL**, and the originals bucket "must never be public" because a retained
 * original carries the EXIF — including a foster home's GPS coordinates — that a derivative
 * does not. This route is the resolution. Cloudflare's image pipeline resolves the URL
 * *outside* our isolate, so it can reach a Worker route that no plain same-host `fetch`
 * could; and the route serves nothing without a signed capability over that exact key.
 *
 * Measured both ways in issue #34: the transform through the gated route succeeds at 1 ms of
 * CPU and returns a real JPEG, and the same route with a bad token is refused **403**,
 * surfacing to the caller as `cf-resized: err=9408`.
 *
 * ## Why every failure is 403 and none of them is 404
 *
 * A missing object, a forged token, an expired one and one minted for a different key all
 * answer 403 with no body. The distinction a 404 would draw — this key is not there — is
 * the one piece of information this route exists to withhold: it would turn an unauthorised
 * caller into an oracle for which originals the platform currently holds, and by extension
 * for how many animals a shelter is in the middle of publishing.
 *
 * The token is checked before the bucket is touched, so an unauthorised request costs one
 * HMAC and no R2 read.
 */

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { verifyOriginalToken } from "../../../lib/media/capability.ts";
import { ORIGINAL_PREFIX } from "../../../lib/media/keys.ts";

export const prerender = false;

/** The refusal, and the only response this route has besides the bytes. */
const REFUSED = () => new Response(null, { status: 403 });

export const GET: APIRoute = async ({ params, request }) => {
  const key = params.key;
  if (!key) return REFUSED();

  /**
   * The key must be one this route is allowed to serve, checked before anything else.
   *
   * Astro has already resolved `..` out of the path, and R2 has no directory traversal to
   * exploit in any case — a key is an opaque string, not a filesystem path. This is a
   * narrower rule than traversal: it keeps the route pointed at the originals prefix, so
   * that adding a second prefix to that bucket later cannot silently become readable
   * through a URL that was written before it existed.
   */
  if (!key.startsWith(ORIGINAL_PREFIX)) return REFUSED();

  const url = new URL(request.url);
  const authorised = await verifyOriginalToken(
    env,
    key,
    url.searchParams.get("token"),
    new Date(),
  );
  if (!authorised) return REFUSED();

  const object = await env.ORIGINALS.get(key);
  if (!object) return REFUSED();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  /**
   * Never cached, anywhere, by anyone.
   *
   * The exact opposite of a derivative, and for the exact reason a derivative is immutable:
   * a derivative's key is its content and it is safe forever, while this response's
   * *authorisation* expires in five minutes. A cache that held these bytes would keep
   * serving them after the capability that unlocked them had died — and these are the bytes
   * with the GPS coordinates in them.
   */
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { status: 200, headers });
};
