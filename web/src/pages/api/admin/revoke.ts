/**
 * The one door a revocation comes through, and it is not a page.
 *
 * [ADR 0002](../../../../../docs/adr/0002-no-admin-accounts.md): "**Revocation is
 * deliberately not on a signed link.** It is the rare adversarial action and is done by
 * hand." Issue #53 repeats it — "the rare adversarial action is never one click from an
 * inbox" — and asks for no revoke button. So there is none: this endpoint renders nothing,
 * has no form anywhere in the codebase, and accepts only a `revocation` token, which no email
 * has ever carried and which only `scripts/admin-link.mjs` mints, from the platform's
 * link-signing secret, at a terminal.
 *
 * **Why an endpoint at all, rather than a hand-written `INSERT`.** A revocation delists every
 * animal a shelter has published, and the shelter has to be told: issue #45's story is "I
 * want a refusal or a Revocation to arrive as a real email inviting a reply, so that a
 * mistake about me is correctable by a human". A hand-written insert writes the entry and
 * sends nothing — it delists a shelter silently, which is the one failure this ticket's
 * design is most careful about everywhere else. Going through `decideVerification()` means
 * the entry and the email are one act, the same act a refusal is.
 *
 * The bar this actually sets is higher than a button's, which is the argument for it being
 * acceptable under ADR 0002: revoking requires the platform's own secret and a command, where
 * verifying requires a link in an inbox.
 *
 * ## Shape
 *
 * `POST`, form-encoded, no `GET`. Form-encoded rather than JSON because it goes through the
 * same `parseDecision()` the decision page does — one parser, so the evidence requirement
 * cannot hold on one path and not the other — and because Astro's `security.checkOrigin`
 * covers form posts, which is a CSRF defence worth keeping even on an endpoint whose real
 * guard is a signed token. `scripts/admin-link.mjs` sends the `Origin` header a browser would.
 *
 * The response is `text/plain`: the only caller is a script, and a person reading its output
 * in a terminal wants the outcome and whether the shelter was told.
 */

import { createDb } from "@pawster/db";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { decideVerification } from "../../../lib/verification/decide.ts";
import { parseDecision } from "../../../lib/verification/decision.ts";
import {
  authorises,
  refuseAdminLinkAsText,
  verifyAdminLink,
} from "../../../lib/verification/link.ts";
import { HAND_ONLY_OUTCOMES } from "../../../lib/verification/policy.ts";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);
  const now = new Date();

  const form = await request.formData();
  const token = form.get("t");
  const claims = await verifyAdminLink(
    env,
    typeof token === "string" ? token : null,
    now,
  );
  /**
   * `"revocation"` and nothing else. A seven-day decision link out of the admin's inbox is
   * refused here exactly as a stranger's guess is, which is what makes ADR 0002's sentence
   * structural: the capability to revoke is a different capability, not a different button.
   */
  if (!authorises(claims, "revocation") || !claims.shelterId) return refuseAdminLinkAsText();

  const parsed = parseDecision(form, HAND_ONLY_OUTCOMES);
  if (!parsed.ok) {
    return new Response(
      `${parsed.errors.map((error) => `${error.field}: ${error.reason}`).join("\n")}\n`,
      { status: 422, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const result = await decideVerification(
    db,
    env,
    {
      shelterId: claims.shelterId,
      outcome: parsed.value.outcome,
      methods: parsed.value.methods,
      evidence: parsed.value.evidence,
      decidedBy: claims.admin,
    },
    now,
  );

  if (!result.recorded) return refuseAdminLinkAsText();

  return new Response(
    [
      `${parsed.value.outcome} recorded for ${claims.shelterId} by ${claims.admin}.`,
      result.shelterMailed
        ? "The shelter has been emailed and can reply to you."
        : "WARNING: the shelter was NOT emailed — Resend refused. Write to them yourself.",
      "Its animals are delisted through the listing rule. Nothing was deleted, and",
      "re-verifying restores everything.",
      "",
    ].join("\n"),
    {
      status: result.shelterMailed ? 200 : 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
};
