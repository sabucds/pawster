/**
 * The signed link that is the entire admin credential.
 *
 * [ADR 0002](../../../../docs/adr/0002-no-admin-accounts.md) gave the Platform Admin no
 * account: "there is no admin account, no admin role in the auth system, and no admin UI to
 * keep in step with the rest of the app", and `CONTEXT.md` says an admin "is identified only
 * by the email address a signed link was sent to". This file is that link.
 *
 * It is [ADR 0008](../../../../docs/adr/0008-confirmation-is-a-capability-not-a-session.md)'s
 * shape, and the properties that make it a capability rather than a session are the same
 * ones `../photos/capability.ts` lists: it authorises **one act on one subject**, it carries
 * its own expiry, and holding it grants nothing else. Two differences from a Session are
 * worth naming because they are the security argument:
 *
 * - **No cookie is ever set and none is ever read.** A route that took a cookie would be a
 *   route with an admin session on it, which is the thing ADR 0002 refused to build.
 *   `scripts/check-source-rules.mjs` fails the build if anything under `pages/admin/` or
 *   `pages/api/admin/` names a cookie, so this holds for the admin routes nobody has written
 *   yet.
 * - **The admin's address travels inside the signed payload**, and that is what makes
 *   `verifications.decided_by` honest. Reading the address from configuration at decision
 *   time would attribute a decision to whoever the admin *is now*; reading it from the link
 *   attributes it to the inbox that actually held the capability, which is the only thing
 *   ADR 0002 ever claimed to know about an admin.
 *
 * ## Why this is the platform's fourth secret
 *
 * `ADMIN_LINK_SECRET`, and not a domain-separated use of `SIGN_IN_SECRET`. ADR 0013 argues
 * for few secrets and that argument is real — "every additional secret is another thing
 * `wrangler secret put` has to be told about and another way a deploy can be
 * half-configured". What outweighs it is the blast radius of a rotation, which is the same
 * test `../photos/capability.ts` applied to `ORIGINAL_SECRET`:
 *
 * - Rotating this invalidates the admin's outstanding links. The admin mints a fresh one
 *   (`scripts/admin-link.mjs`) and loses nothing.
 * - Rotating `SIGN_IN_SECRET` invalidates every outstanding One-Time Code on the platform,
 *   which is mail already sent to forty inboxes.
 *
 * And the reason one would rotate them differs, which is the sharper half: this key is
 * rotated *because a link leaked out of the admin's inbox*, and that emergency must not also
 * be an emergency for every shelter mid-sign-in. `digest/` already holds
 * `UNSUBSCRIBE_SECRET` separately on exactly this reasoning — one secret per thing that can
 * be revoked on its own.
 */

import { digestsEqual, sign, toBase64Url } from "../auth/crypto.ts";
import { DECISION_LINK_TTL_MS, PENDING_LIST_LINK_TTL_MS } from "./policy.ts";

export interface AdminLinkSecrets {
  readonly ADMIN_LINK_SECRET: string;
}

/**
 * The three things a link can authorise, and the reason `revocation` is one of them.
 *
 * ADR 0002 puts revocation "off any link" and issue #53 repeats it: "the rare adversarial
 * action is never one click from an inbox", so this ticket builds no revoke button. A
 * `revocation` token is not a contradiction of that — it is what makes the sentence
 * enforceable. Nothing mints one but a maintainer at a terminal holding the platform's
 * link-signing secret (`scripts/admin-link.mjs`), no email has ever carried one, and the
 * only route that accepts one renders no page and has no form. The alternative was a
 * revocation performed as a hand-written `INSERT`, which writes the log entry and sends the
 * shelter nothing — and the shelter's replyable email is the half of a revocation that
 * ADR 0002 and issue #53 both care most about.
 */
export type AdminLinkKind = "decision" | "pending" | "revocation";

export interface AdminLinkClaims {
  readonly kind: AdminLinkKind;
  /**
   * The shelter this link authorises, or `null` for the pending list.
   *
   * `null` rather than an empty string, and checked on the way out: a `decision` token whose
   * subject failed to encode would otherwise be a token that authorises *some* shelter,
   * which is not a thing this platform should be able to represent.
   */
  readonly shelterId: string | null;
  /** The address this link was sent to, which is the whole of who the admin is. */
  readonly admin: string;
  readonly expiresAt: Date;
}

/**
 * How long each kind lives. **The caller does not get to choose**, which is why this is a
 * lookup and not an argument: the seven days and the twenty-four hours are ADR 0002's
 * mitigation for the admin's inbox being the admin credential, and a TTL a call site passed
 * in would be a mitigation each call site could weaken.
 *
 * A revocation token is minted at a terminal and spent seconds later, so it gets the shorter
 * of the two windows rather than a third figure of its own.
 */
const TTL_MS: Record<AdminLinkKind, number> = {
  decision: DECISION_LINK_TTL_MS,
  pending: PENDING_LIST_LINK_TTL_MS,
  revocation: PENDING_LIST_LINK_TTL_MS,
};

export function ttlFor(kind: AdminLinkKind): number {
  return TTL_MS[kind];
}

/**
 * The wire form: `base64url(JSON) "." base64url(HMAC)`, the same shape
 * `../auth/session.ts` uses for a Session cookie and for the same reason — JSON so that no
 * field's value can be mistaken for a separator, one-letter keys because the shape is fixed
 * here and nowhere else.
 */
interface Payload {
  /** Kind. */
  k: AdminLinkKind;
  /** Shelter id, absent for the pending list. */
  s?: string;
  /** The admin address this was sent to. */
  a: string;
  /** Expiry, epoch milliseconds. */
  x: number;
}

const KINDS: readonly AdminLinkKind[] = ["decision", "pending", "revocation"];

/**
 * Mint a token for one act, expiring by its kind's rule.
 *
 * The expiry is **inside the signed payload** rather than beside it, which is the difference
 * between an expiry and a suggestion: otherwise the holder edits the number and the
 * signature still verifies. Same reason `mintOriginalToken()` signs its own deadline.
 */
export async function mintAdminLink(
  secrets: AdminLinkSecrets,
  claims: {
    readonly kind: AdminLinkKind;
    readonly shelterId?: string | null;
    readonly admin: string;
  },
  now: Date,
): Promise<string> {
  if (claims.kind !== "pending" && !claims.shelterId) {
    throw new Error(`an admin ${claims.kind} link must name a shelter`);
  }

  const payload: Payload = {
    k: claims.kind,
    a: claims.admin,
    x: now.getTime() + ttlFor(claims.kind),
  };
  if (claims.shelterId) payload.s = claims.shelterId;

  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(secrets.ADMIN_LINK_SECRET, "admin", encoded);
  return `${encoded}.${signature}`;
}

/**
 * The claims this token carries, or `null`.
 *
 * `null` is every failure — absent, malformed, expired, tampered with, signed under another
 * secret — and every route answers all of them the same way, without saying which. The
 * distinction an attacker would want is *expired* versus *forged*: knowing a token was once
 * real tells the holder that the address it came from is the admin's, and there is nobody who
 * needs to know that.
 *
 * The signature is checked before the clock, so a forged token and a stale one cost the same
 * work.
 */
export async function verifyAdminLink(
  secrets: AdminLinkSecrets,
  token: string | null | undefined,
  now: Date,
): Promise<AdminLinkClaims | null> {
  if (!token) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const encoded = token.slice(0, separator);
  const expected = await sign(secrets.ADMIN_LINK_SECRET, "admin", encoded);
  if (!digestsEqual(token.slice(separator + 1), expected)) return null;

  const payload = decodePayload(encoded);
  if (!payload) return null;
  if (now.getTime() >= payload.x) return null;

  return {
    kind: payload.k,
    shelterId: payload.s ?? null,
    admin: payload.a,
    expiresAt: new Date(payload.x),
  };
}

/**
 * Validated field by field rather than cast, the same way `decodeSession()` does it: the
 * signature already proves we minted this, so a malformed payload is our own bug or an old
 * format — and a cast would turn either into a `TypeError` deep inside a route instead of a
 * 404, which is the recoverable answer.
 */
function decodePayload(encoded: string): Payload | null {
  let json: string;
  try {
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

  if (typeof parsed !== "object" || parsed === null) return null;
  const { k, s, a, x } = parsed as Partial<Payload>;
  if (typeof k !== "string" || !KINDS.includes(k as AdminLinkKind)) return null;
  if (typeof a !== "string" || a.length === 0) return null;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (s !== undefined && (typeof s !== "string" || s.length === 0)) return null;
  // A decision or a revocation authorises *one* shelter, so a payload of that kind with no
  // subject authorises nothing and must not be treated as authorising anything.
  if (k !== "pending" && !s) return null;

  return { k: k as AdminLinkKind, s, a, x };
}

/**
 * Whether these claims authorise this act on this subject.
 *
 * Both halves in one call, because checking the kind and forgetting the subject is the
 * mistake worth designing against: a decision token for shelter A posted to shelter B's form
 * would otherwise verify. The `shelterId` a route passes comes from the *token* in practice,
 * so this is mostly a guard against a route that reads a subject from anywhere else.
 */
export function authorises(
  claims: AdminLinkClaims | null,
  kind: AdminLinkKind,
  shelterId?: string,
): claims is AdminLinkClaims {
  if (!claims) return false;
  if (claims.kind !== kind) return false;
  if (shelterId !== undefined && claims.shelterId !== shelterId) return false;
  return true;
}

/**
 * The one response every admin route gives to a link it will not honour.
 *
 * It lives beside {@link verifyAdminLink} rather than in each route, because *identical* is
 * the security property: absent, malformed, expired, tampered with, minted for another kind
 * or naming a shelter that is gone all have to look the same from outside. Three routes
 * writing their own refusal is three chances for one of them to be more informative than the
 * others — and the thing an attacker learns from a distinguishable refusal is whether the
 * inbox they are guessing at is the admin's.
 *
 * **404 and not 403**, which is a deliberate reversal of `api/originales/[...key].ts`. That
 * route answers a machine — Cloudflare's image pipeline, which needs to know its token was
 * rejected. This one answers a person holding a URL whose only meaning was its token: with
 * the token spent there is no resource at this address, and "not found" says exactly that
 * without confirming that a decision page for some shelter exists at all.
 */
export function refuseAdminLink(): Response {
  return new Response(
    [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta name="robots" content="noindex, nofollow">',
      "<title>Not found — Pawster admin</title></head><body>",
      "<h1>Not found</h1>",
      "<p>This link is not valid. Decision links last seven days and the pending list",
      "twenty-four hours; mint a new one with <code>node scripts/admin-link.mjs</code>.</p>",
      "</body></html>",
      "",
    ].join("\n"),
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/**
 * Where the two admin pages live. One place, so a mail and a page cannot disagree — the
 * decision path in particular is written into a mail, into the pending list's rows and into
 * the decision page's own form action and post-redirect.
 *
 * **There is no constant for the revoke endpoint**, and its absence is honest rather than an
 * oversight. Nothing inside the Worker ever builds that URL: the endpoint renders no page,
 * appears in no mail and is linked from nowhere, so the only thing that names it is
 * `scripts/admin-link.mjs`, which posts to it from outside the Worker and cannot import
 * this file (see that script on why). A constant here would look like a shared source of
 * truth while having exactly one reader.
 */
export const ADMIN_DECISION_PATH = "/admin/decide";
export const ADMIN_PENDING_PATH = "/admin/pending";

/**
 * The full URL for a token, built from the origin the platform answers on.
 *
 * `SITE_ORIGIN` and not a relative path, because these strings only ever appear in email —
 * and in the terminal output of `scripts/admin-link.mjs`, which is the other place a link
 * has to be clickable.
 */
export function adminLinkUrl(
  origin: string,
  path: string,
  token: string,
): string {
  return `${origin}${path}?t=${encodeURIComponent(token)}`;
}
