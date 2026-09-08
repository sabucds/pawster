/**
 * The one email the signup path sends.
 *
 * `POST /emails` per address, the same endpoint and posture `digest/src/resend.ts` and
 * `../auth/mail.ts` take, and never the batch endpoint — its idempotency key covers the whole
 * payload, which is wrong for a per-recipient send, and a signup concerns exactly one address.
 *
 * **No idempotency key**, for `../auth/mail.ts`'s reason rather than the digest's: a signup is
 * not a retry of anything. Two signups a day apart are two different searches waiting to be
 * proved, and a key derived from the address and the day would have swallowed the second and
 * left a subscriber holding a link to a row that was never written.
 *
 * ## Why this one carries a link when the sign-in mail deliberately does not
 *
 * ADR 0013 chose a *code* for shelters because "a corporate mail scanner fetches URLs with no
 * human behind them", and `../auth/mail.ts` has no link anywhere in its body as a result. The
 * opposite choice here is not an inconsistency; it is the same worry answered by ADR 0008's
 * other rule.
 *
 * A shelter's sign-in is a login, so a fetched link would be a session handed to a robot. An
 * opt-in is a *proof that a mailbox exists and is read*, and there is no code to type back:
 * asking an adopter to copy six digits out of a mail into a page they no longer have open
 * would put a typing task in front of the one step nothing works without. So the link stays,
 * and the scanner is handled where ADR 0008 handles it — the link opens a page and **the
 * opt-in is a `POST` from it**. A prefetcher that fetches this URL renders a page and
 * subscribes nobody.
 *
 * ## One language, and it is not an oversight
 *
 * The subscriber's locale is captured at signup and stored (ADR 0018), because the digest is
 * the one surface whose language is a per-subscriber fact rather than a property of the URL.
 * This mail is written in es-VE only, which is currently exact rather than approximate:
 * `astro.config.mjs` puts English under `/en/`, no page exists there yet, and the signup form
 * is the only thing that submits a locale — so `en` is not reachable today. When it is, the
 * body below is the third consumer ADR 0018 names and it takes its strings from `strings/`
 * like the others.
 */

import { OPT_IN_TTL_MS } from "./policy.ts";

export interface OptInMailEnv {
  readonly RESEND_API_KEY: string;
  /**
   * The same sender the digest uses, and deliberately not `SIGN_IN_FROM_ADDRESS`.
   *
   * `web/wrangler.jsonc` keeps the sign-in sender separate "so a shelter's mail client and
   * Postmaster Tools can tell a credential from a newsletter, and so a spam complaint about
   * the digest cannot take the sign-in sender's reputation with it". This mail is the first
   * message of the digest relationship: it should arrive from the address every later digest
   * arrives from, so a subscriber who allow-lists it once is done, and a complaint about it
   * lands on the reputation it actually belongs to.
   */
  readonly DIGEST_FROM_ADDRESS: string;
  readonly SITE_ORIGIN: string;
}

export interface OptInMail {
  readonly to: string;
  /** The plaintext token. Only the keyed hash of it reaches the database. */
  readonly token: string;
}

const TTL_DAYS = Math.round(OPT_IN_TTL_MS / (24 * 60 * 60_000));

/**
 * Where a token is redeemed. One function so the mail and the route cannot disagree about
 * the query parameter's name — a mismatch there is a link that arrives looking perfect and
 * finds nothing.
 */
export function optInUrl(origin: string, token: string): string {
  return `${origin}/resumen/activar?t=${encodeURIComponent(token)}`;
}

/**
 * Send one opt-in link.
 *
 * Throws if Resend refuses. By then the caller has written its ledger row, which costs this
 * address its 24 hours and the platform one of its six — and that is the right way round,
 * because otherwise a failed send would let a caller retry without limit against the one
 * unauthenticated endpoint here that spends money.
 */
export async function sendOptInEmail(
  env: OptInMailEnv,
  mail: OptInMail,
): Promise<void> {
  const url = optInUrl(env.SITE_ORIGIN, mail.token);

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM_ADDRESS,
      to: [mail.to],
      subject: "Activa tu búsqueda en Pawster",
      /**
       * Plain text only, and the link on a line of its own so every mail client makes it
       * clickable without markup.
       *
       * The last line is the one that matters most and is not boilerplate: an address that
       * did not ask for this must be told that ignoring the mail is sufficient. Nothing has
       * been created yet, so silence really is the whole answer — which is only true because
       * `createPendingOptIn()` writes nothing that can be mailed.
       */
      text: [
        "Alguien pidió recibir el resumen de animales en adopción de Pawster con este correo.",
        "",
        "Si fuiste tú, abre este enlace para activarla:",
        url,
        "",
        `El enlace sirve una sola vez y vence en ${TTL_DAYS} días.`,
        "",
        "Si no fuiste tú, no hace falta que hagas nada: sin ese enlace no te llega ningún resumen y borramos esta solicitud en unos días.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend rejected the opt-in link: ${response.status}`);
  }
}
