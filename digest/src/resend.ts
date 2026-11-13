import type { Env } from "./env.ts";

/**
 * One `POST /emails` per recipient, never the batch endpoint. Batch takes 100 per
 * rate-limit unit, which sounds made for this and is a trap: its idempotency key covers
 * the whole payload, so a resumed run that drops one recipient gets a 409 and a resumed
 * run with a fresh key re-sends everyone who already received it. Its sole advantage is
 * worthless against a 10 req/s limit we could not approach with a 100-emails-per-day
 * ceiling (ADR 0009).
 */

export interface DigestSend {
  to: string;
  /** `digest/<period>/<subscriberId>`. Resend's idempotency window is 24 hours, which the
   * one-shard-per-day design keeps us inside. */
  idempotencyKey: string;
  /** Rendered by `email.ts`. A redelivery may render differently; Resend then 409s the key. */
  html: string;
  /** Built and signed by `unsubscribe.ts`; this module only posts what it is handed. */
  unsubscribeUrl: string;
}

export async function sendDigestEmail(
  env: Env,
  send: DigestSend,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": send.idempotencyKey,
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM_ADDRESS,
      to: [send.to],
      subject: "Animales que coinciden con tu búsqueda",
      html: send.html,
      headers: {
        // We host the entire unsubscribe flow: these are automatic for Broadcasts only,
        // and Broadcasts cannot carry a Pawster digest at all (ADR 0009).
        "List-Unsubscribe": `<${send.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  // A 409 on our key means this email already went out (or is going out right now): the
  // retry of a message whose D1 write failed renders today's rows, which may differ from
  // what was sent. Treat it as sent, so the consumer writes the sent-set instead of looping.
  if (response.status === 409) return;
  if (!response.ok) {
    throw new Error(`Resend rejected the send: ${response.status}`);
  }
}
