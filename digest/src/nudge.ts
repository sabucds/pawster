/**
 * The one mail sent to a subscriber whose searches have never matched anything.
 *
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) is the whole reason it exists,
 * and the reason is not engagement: **"a subscriber who never matches anything receives no
 * digest and therefore no footer, so the opt-in success page and the 90-day 'still nothing'
 * nudge both carry the manage link, guaranteeing a live link at least quarterly."**
 *
 * The manage page is the subject-access response and the only place the erasure button lives.
 * A subscriber whose searches match nothing has consented to something we are still acting on
 * — we hold their address, their three searches and their send day — while holding no route
 * back to any of it, because the only link they were ever given was on the opt-in success page
 * they closed months ago. That is the gap. It is a data-protection obligation wearing the
 * clothes of a re-engagement email, and it is deliberately written as the former: it reports
 * that nothing matched, and it hands back a link.
 *
 * **Once, and the row is what enforces that** — `subscribers.nudged_at`, written by
 * `recordNudge()` after the send. The period alone would nudge the same silent subscriber
 * every day the cron ran.
 *
 * One language, es-VE, for the reason `web/src/lib/subscriber/mail.ts` gives about the opt-in
 * mail: `astro.config.mjs` puts English under `/en/`, no page exists there yet, and the signup
 * form is the only thing that submits a locale, so `en` is not reachable today. When it is,
 * this is one of the consumers ADR 0018 names and it takes its strings from `strings/`.
 */

import { manageUrl, unsubscribeUrl } from "@pawster/domain";
import type { Env } from "./env.ts";

/**
 * How many nudges one run may send, and **they are spent from the digest's own reservation
 * rather than from a new one.**
 *
 * That is arithmetic rather than a preference. `web/src/lib/subscriber/policy.ts` divides
 * Resend's hundred-a-day between the digest (70), shelter sign-in (20), confirmation nudges
 * (~4) and opt-in links (6), and the sum is already a hundred — there is no slack to give
 * this. There does not need to be: every recipient of a nudge is by definition a subscriber
 * the digest is *not* reaching, so the mail takes the slot the digest would have taken.
 * `index.ts` makes that literal by shrinking the shard's limit by however many nudges went
 * out, which keeps the run's total sends bounded by `DIGEST_DAILY_BUDGET` whatever the mix.
 *
 * Five rather than the whole budget, so a platform that has just crossed its first ninety days
 * cannot spend an entire day's allowance telling people nothing matched. The backlog drains
 * at five a day and nobody's link expires in the meantime.
 */
export const NUDGES_PER_RUN = 5;

export interface Nudge {
  readonly to: string;
  readonly subscriberId: string;
  /** `subscribers.manage_token_version`, so the link carries the generation now live. */
  readonly manageTokenVersion: number;
}

/**
 * Send one nudge. Throws if Resend refuses, so the caller leaves `nudged_at` unwritten and the
 * next run tries again — see `recordNudge()` for why that ordering is the opposite of the
 * opt-in ledger's.
 *
 * **No idempotency key.** A key would be derived from the subscriber and the day, and the
 * thing that actually makes this send-once is `nudged_at`; adding a second, weaker guarantee
 * with a 24-hour window would only hide a failure of the first.
 */
export async function sendNudgeEmail(env: Env, nudge: Nudge): Promise<void> {
  const url = await manageUrl(env, {
    subscriberId: nudge.subscriberId,
    version: nudge.manageTokenVersion,
  });
  const unsubscribe = await unsubscribeUrl(env, nudge.subscriberId);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM_ADDRESS,
      to: [nudge.to],
      subject: "Todavía no hay animales que coincidan con tu búsqueda",
      /**
       * Plain text, with the link on a line of its own so every mail client makes it
       * clickable without markup.
       *
       * The message says the true thing — nothing matched — rather than inventing activity,
       * and it leads with what the subscriber can do about it. The last line is the one the
       * ADR asks for: the link works, and it is the way out as well as the way in.
       */
      text: [
        "Han pasado tres meses desde que activaste tu búsqueda en Pawster y todavía no ha aparecido ningún animal que coincida con ella.",
        "",
        "No hace falta que hagas nada: si aparece alguno, te llega el resumen como siempre.",
        "",
        "Desde aquí puedes ver lo que guardamos tuyo, cambiar tu búsqueda, darte de baja o borrarlo todo:",
        url,
        "",
        "Guarda este enlace: es el único que tienes para entrar, porque en Pawster no hay contraseñas.",
      ].join("\n"),
      /**
       * The same one-click headers every digest carries (RFC 8058). A nudge is a mail a
       * subscriber did not ask for individually, so it must be as unsubscribable as the
       * digest it stands in for — and `List-Unsubscribe` is what a mail client turns into the
       * button people actually press instead of the spam report.
       *
       * It is the *manage* link that is in the body and the *unsubscribe* link that is in the
       * header, and they are different links on purpose: the header must never open a page
       * that can erase anything, and the body link must be the one that survives.
       */
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend rejected the nudge: ${response.status}`);
  }
}
