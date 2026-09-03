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
  period: string;
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
      html: `<p>Digest for ${send.period}.</p>`,
      headers: {
        // We host the entire unsubscribe flow: these are automatic for Broadcasts only,
        // and Broadcasts cannot carry a Pawster digest at all (ADR 0009).
        "List-Unsubscribe": `<https://pawster.dpdns.org/unsubscribe/${send.idempotencyKey}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend rejected the send: ${response.status}`);
  }
}
