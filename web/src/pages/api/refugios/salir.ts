/**
 * Sign out.
 *
 * `POST` and not `GET`, which is the whole reason this is an endpoint rather than a link. A
 * `GET` that ended a session could be fired by a mail scanner, a link prefetcher or an
 * `<img>` on someone else's page — the same class of failure ADR 0008 rules out by
 * forbidding an emailed link from mutating on `GET`, and the reason ADR 0013 chose a typed
 * code over a magic link in the first place.
 *
 * `POST` and not `DELETE` for a duller reason: an HTML form can only send `GET` or `POST`,
 * and the sign-out button has to work with no JavaScript on the page.
 *
 * It clears the cookie and **writes nothing to the database**. Bumping `sessionEpoch` here
 * would sign out every device the shelter shares its account email with, and ADR 0008 makes
 * that sharing a normal way to work rather than an anomaly: forwarding is delegation.
 * Wholesale revocation is a separate, deliberate act, not the exit button.
 */

import type { APIRoute } from "astro";
import { endSession } from "../../../lib/auth/guard.ts";

export const prerender = false;

export const POST: APIRoute = () =>
  new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": endSession() },
  });
