/**
 * Save a search, and mail the link that proves the address.
 *
 * The subscriber path's counterpart to `api/refugios/codigo.ts`, and the same three things
 * are true of it: it is unauthenticated by necessity, it can spend money, and its *response*
 * is as much of the specification as its behaviour.
 *
 * An action endpoint rather than a page, so the form that posts here stays prerendered and
 * costs no Worker invocation (ADR 0007). The Worker runs on the post.
 *
 * ## The identical response, stated exactly
 *
 * Issue #61's third acceptance criterion: a new address, an already-subscribed address and a
 * Do-Not-Contact address must be answered identically. Four states converge on
 * {@link CHECK_INBOX} below — those three plus an address inside its 24-hour cooldown — and
 * the response is a bare 303 with a fixed `Location` and no cookie, so there is not even a
 * random token to reason about. Nothing varies.
 *
 * Two refusals *are* spoken, and `SPEAKABLE_REFUSALS` is that division as data rather than as
 * a condition here: the per-IP limit is a fact about the caller and the daily ceiling is a
 * fact about the platform, so neither reveals anything about any address. A refusal added to
 * `SignupRefusal` later is silent until somebody names it there, which is the safe default.
 *
 * **A malformed address is the one thing about the submitted field that is spoken**, and
 * `signup.ts` carries the argument: that rule closes an enumeration oracle, and "this is not
 * shaped like an email" answers nothing about anybody's inbox. It is checked first, so a
 * request with nothing usable in it costs no reads and no writes.
 *
 * **The response timing still leaks, and is not fixed here.** Only the sending branch awaits
 * Resend, so it answers hundreds of milliseconds later than a silent refusal. Closing that
 * needs either a `waitUntil` the Astro adapter no longer exposes or a fixed response floor
 * that spends the CPU ADR 0007 is trying not to spend. The honest statement, the same one
 * `codigo.ts` makes: this endpoint resists *reading* the answer and not *timing* it.
 */

import { createDb } from "@pawster/db";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { clientIp } from "../../../lib/client-ip.ts";
import {
  doNotContactCanary,
  doNotContactDigest,
  generateOptInToken,
  hashOptInToken,
  hashSignupIp,
  hashSubscriberEmail,
} from "../../../lib/subscriber/crypto.ts";
import { sendOptInEmail } from "../../../lib/subscriber/mail.ts";
import { isSpeakable, refuseSignup } from "../../../lib/subscriber/policy.ts";
import { parseSignup } from "../../../lib/subscriber/signup.ts";
import {
  assertPepperUnchanged,
  createPendingOptIn,
  readSignupState,
  recordOptInMail,
} from "../../../lib/subscriber/store.ts";

export const prerender = false;

/**
 * The one response four different states share. See the module comment.
 *
 * Named for what it tells the subscriber rather than for any of the states that reach it,
 * because naming it after one of them — `SENT`, say — is how a later edit starts believing it
 * means the mail went out.
 */
const CHECK_INBOX = "/resumen/revisa-tu-correo";

/** Not an address, and safe to say so. */
const BAD_ADDRESS = "/resumen/correo-invalido";

/** The caller is asking too often. A fact about the caller. */
const TOO_MANY = "/resumen/demasiados";

/** The platform has no opt-in mail left today. A fact about the platform. */
const TRY_LATER = "/resumen/espera";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);
  const now = new Date();

  /**
   * Read before anything else, so a post with no usable address in it costs one `FormData`
   * parse and nothing more — no hashes, no queries, no row. It is also the only branch here
   * that can answer without consulting the database at all.
   */
  const parsed = parseSignup(await request.formData());
  if (!parsed.ok) return seeOther(BAD_ADDRESS);
  const { email, criteria, locale } = parsed.value;

  /**
   * Before the Do-Not-Contact list is *trusted*, not merely before it is read.
   *
   * ADR 0010's failure mode for the pepper is silence: a wrong one matches nobody, the list
   * appears empty, and the platform resumes mailing people who reported it as spam with no
   * alarm anywhere. So the canary is checked on the one path whose correctness depends on the
   * list, and a mismatch throws — a 500 on every signup is the loud failure the ADR asks for,
   * and it is loud in the right direction: no mail goes out while it stands.
   *
   * It leaks nothing, because the check is address-independent: it either throws for
   * everybody or for nobody.
   */
  await assertPepperUnchanged(db, await doNotContactCanary(env), now);

  const ipHash = await hashSignupIp(env, clientIp(request));
  const emailHash = await hashSubscriberEmail(env, email);

  const state = await readSignupState(
    db,
    {
      email,
      emailHash,
      doNotContactDigest: await doNotContactDigest(env, email),
      ipHash,
    },
    now,
  );

  const refusal = refuseSignup(state, now);
  if (refusal !== null) {
    /**
     * No row is written on any refusal, speakable or not, and that is what bounds this
     * endpoint: every write below is downstream of a `null` verdict, so a caller over the IP
     * limit costs two indexed `COUNT(*)`s and a caller on the Do-Not-Contact list costs three
     * reads. `codigo.ts` needs its refused requests in the ledger because its IP limit counts
     * requests; this one's counts pending rows, so a refusal has nothing to record.
     */
    if (!isSpeakable(refusal)) return seeOther(CHECK_INBOX);
    return seeOther(refusal === "ip-rate-limited" ? TOO_MANY : TRY_LATER);
  }

  const token = generateOptInToken();

  /**
   * The pending row **and nothing that can be mailed** — the ticket's first acceptance
   * criterion, satisfied by not writing a subscriber rather than by writing one in a pending
   * state. `store.ts` says the same thing from the query's end.
   */
  await createPendingOptIn(
    db,
    { tokenHash: await hashOptInToken(env, token), email, criteria, locale, ipHash },
    now,
  );

  /**
   * The ledger row goes in **before** the send, so a Resend failure still costs this address
   * its 24 hours and the platform one of its six. The other way round, a caller could retry
   * without limit against the one endpoint here that spends money.
   */
  await recordOptInMail(db, emailHash, now);

  /**
   * A failed send must not change the response, and this `catch` is what makes the
   * identical-response rule actually hold rather than nearly hold.
   *
   * Without it a Resend outage turns `sendOptInEmail`'s throw into a 500 — but only on this
   * branch, the one a refused address never reaches. That difference is a working enumeration
   * oracle: submit an address during any outage and the status code says whether it was on
   * the Do-Not-Contact list. It is the same failure `codigo.ts` guards, arriving through the
   * path nobody thinks of as a branch.
   *
   * The rows stay written. The pending row is a link nobody received, which the seven-day
   * purge takes; the ledger row is an allowance spent, which is deliberate — a retry loop
   * must not be free just because the send failed.
   */
  try {
    await sendOptInEmail(env, { to: email, token });
  } catch (error) {
    // `observability` is enabled in `web/wrangler.jsonc`, so this reaches the dashboard. The
    // token is never logged; it is a live capability. Nor is the address, which is the one
    // thing here the platform holds no consent for.
    console.error("opt-in link send failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return seeOther(CHECK_INBOX);
};
