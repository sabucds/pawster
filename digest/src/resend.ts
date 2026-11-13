import type { Env } from "./env.ts";

/**
 * Every email the worker sends goes through {@link sendMail}: one `POST /emails` per
 * recipient, never the batch endpoint. Batch takes 100 per rate-limit unit, which sounds made
 * for this and is a trap: its idempotency key covers the whole payload, so a resumed run that
 * drops one recipient gets a 409 and a resumed run with a fresh key re-sends everyone who
 * already received it. Its sole advantage is worthless against a 10 req/s limit we could not
 * approach with a 100-emails-per-day ceiling (ADR 0009).
 */

export interface Mail {
  to: string;
  subject: string;
  /** One of `html` or `text`. */
  html?: string;
  text?: string;
  /** Adds the one-click `List-Unsubscribe` headers (RFC 8058). */
  unsubscribeUrl?: string;
  /** Resend's idempotency window is 24 hours. */
  idempotencyKey?: string;
}

/** Throws when Resend refuses, so each caller can leave its record unwritten and retry. */
export async function sendMail(
  env: Pick<Env, "RESEND_API_KEY" | "DIGEST_FROM_ADDRESS">,
  mail: Mail,
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      ...(mail.idempotencyKey ? { "idempotency-key": mail.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: env.DIGEST_FROM_ADDRESS,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: mail.unsubscribeUrl
        ? {
            // We host the entire unsubscribe flow: these are automatic for Broadcasts only,
            // and Broadcasts cannot carry a Pawster email at all (ADR 0009).
            "List-Unsubscribe": `<${mail.unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined,
    }),
  });

  // Resend answers 409 only on a reused idempotency key: this email already went out (or is
  // going out right now). The retry of a digest whose D1 write failed renders today's rows,
  // which may differ from what was sent. Treat it as sent, so the consumer writes the
  // sent-set instead of looping.
  if (response.status === 409) return;
  if (!response.ok) {
    throw new Error(`Resend rejected "${mail.subject}": ${response.status}`);
  }
}
