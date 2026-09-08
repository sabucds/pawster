/**
 * The one email shelter access sends.
 *
 * `POST /emails` per code, the same endpoint and posture `digest/src/resend.ts` uses, and
 * for the reason recorded there: never the batch endpoint. Its idempotency key covers the
 * whole payload, which is wrong for a per-recipient send — and there is nothing to batch
 * here anyway, since a code request concerns exactly one address.
 *
 * **No idempotency key is sent, and that is the opposite of the digest's choice.** A digest
 * is re-runnable by construction and its key is what makes a redelivered queue message a
 * no-op. A code request is not a retry of anything: every request mints a *new* code and
 * retires the last, so two requests must produce two emails. A key derived from the shelter
 * and the day would have silently swallowed the second one and left a shelter holding a code
 * that the database had already superseded — the worst failure available here, because it
 * looks like a wrong code.
 *
 * **No link, anywhere in the body.** ADR 0013 chose a code over a magic link because a
 * corporate mail scanner fetches URLs with no human behind them, and ADR 0008 forbids an
 * emailed link from mutating on `GET`. A "click here to sign in" convenience link would
 * reintroduce exactly that, so the email carries digits and a bare origin to type.
 */

import { ONE_TIME_CODE_TTL_MS } from "./policy.ts";

export interface CodeMailEnv {
  readonly RESEND_API_KEY: string;
  readonly SIGN_IN_FROM_ADDRESS: string;
  readonly SITE_ORIGIN: string;
}

export interface CodeMail {
  readonly to: string;
  readonly code: string;
}

const TTL_MINUTES = Math.round(ONE_TIME_CODE_TTL_MS / 60_000);

/**
 * Send one code.
 *
 * Throws if Resend refuses. The caller has already written its ledger row by then, which
 * costs the shelter one send out of its daily five and is the right way round: a failed
 * send that did not count would let a caller retry without limit against an endpoint whose
 * whole purpose is to be rate-limited.
 */
export async function sendOneTimeCodeEmail(
  env: CodeMailEnv,
  mail: CodeMail,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.SIGN_IN_FROM_ADDRESS,
      to: [mail.to],
      subject: `Tu código para entrar: ${mail.code}`,
      /**
       * The code is in the subject as well as the body, which is a deliberate duplication:
       * a shelter reading the notification on a locked phone can type the code without
       * opening anything, which is the case ADR 0013 had in mind when it said the inbox and
       * the browser are routinely on different devices.
       */
      text: [
        `Tu código para entrar a Pawster es ${mail.code}.`,
        "",
        `Vence en ${TTL_MINUTES} minutos y sirve una sola vez.`,
        `Escríbelo en la página que tienes abierta, en ${env.SITE_ORIGIN}.`,
        "",
        "Si no pediste este código, no hace falta que hagas nada: sin él, nadie entra.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend rejected the sign-in code: ${response.status}`);
  }
}
