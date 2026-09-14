/**
 * Verifying that a delivery event really came from Resend, and reading what it says.
 *
 * Resend signs webhooks with Svix, which is a documented construction rather than a library
 * we have to take: `HMAC-SHA256(secret, "<id>.<timestamp>.<body>")`, base64, compared against
 * one of the space-separated values in `webhook-signature`. Implementing the six lines here
 * rather than adding `svix` keeps a dependency out of a 3 MB Worker bundle for a function
 * `crypto.subtle` already provides — and the alternative to verifying at all is an
 * unauthenticated endpoint that retires any address a caller names, which is a denial-of-mail
 * primitive pointed at every subscriber on the platform.
 *
 * ## Why the signature is checked here and not by a framework
 *
 * There is no framework. `web/` is Astro on Workers and this is one route; the check is a
 * pure function over three strings and a secret, which makes it the one part of the webhook
 * worth a table test — the rest is a database write.
 *
 * The secret is `RESEND_WEBHOOK_SECRET`, prefixed `whsec_` as Svix issues it. It keys nothing
 * else, which is not a fifth secret casually acquired: it is *Resend's* key rather than ours,
 * chosen by them and rotated from their dashboard, so it could not be shared with anything
 * even if that were desirable.
 */

import { digestsEqual } from "@pawster/domain";

export interface WebhookSecrets {
  /** As Svix issues it, including the `whsec_` prefix. */
  readonly RESEND_WEBHOOK_SECRET: string;
}

/**
 * How far out of step a delivery's timestamp may be before it is refused, in seconds.
 *
 * Five minutes is Svix's own tolerance. It exists so that a signature captured off the wire
 * cannot be replayed indefinitely — the signed payload includes the timestamp, so an attacker
 * cannot move it without invalidating the MAC, and after this window the MAC stops being worth
 * anything to them.
 *
 * The window has to be generous enough for a retry from a queue that was briefly stuck, which
 * is what the five minutes is buying and why it is not thirty seconds.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** The three headers Svix sends, pulled off a request. */
export interface SignedDelivery {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly body: string;
}

export function readSignedDelivery(
  request: Request,
  body: string,
): SignedDelivery | null {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (id === null || timestamp === null || signature === null) return null;
  return { id, timestamp, signature, body };
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Whether this delivery was signed by Resend, and recently.
 *
 * The secret is base64 **after** its `whsec_` prefix, and the raw bytes are the HMAC key —
 * signing the printable form instead is the classic way to get a verifier that rejects every
 * genuine delivery, and it fails identically to a wrong secret, which is why it is spelled out
 * rather than inlined.
 *
 * `webhook-signature` holds space-separated `v1,<base64>` values so that Svix can rotate keys
 * without a gap. Any one matching is a pass, and the comparison is constant-time for the
 * reason every other MAC comparison in the platform is.
 */
export async function verifyDelivery(
  secrets: WebhookSecrets,
  delivery: SignedDelivery,
  now: Date,
): Promise<boolean> {
  const sent = Number(delivery.timestamp);
  if (!Number.isFinite(sent)) return false;
  const drift = Math.abs(Math.floor(now.getTime() / 1000) - sent);
  if (drift > WEBHOOK_TOLERANCE_SECONDS) return false;

  const raw = secrets.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, "");
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    // A secret that is not base64 at all. Refusing is the only safe answer: the alternative
    // is a verifier that throws on every delivery, which reads as an outage rather than as a
    // misconfiguration.
    return false;
  }
  /**
   * Built over an explicit `ArrayBuffer` rather than with `Uint8Array.from`, so the result is
   * a `Uint8Array<ArrayBuffer>` and not a `Uint8Array<ArrayBufferLike>` — the latter is not a
   * `BufferSource` as far as `importKey` is concerned, and the error it produces names an
   * overload rather than the cause.
   */
  const keyBytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) keyBytes[i] = decoded.charCodeAt(i);

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = base64(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        `${delivery.id}.${delivery.timestamp}.${delivery.body}`,
      ),
    ),
  );

  return delivery.signature
    .split(" ")
    .some((value) => digestsEqual(value.replace(/^v1,/, ""), expected));
}

/**
 * What a delivery event means for a subscriber, or `null` when it means nothing.
 *
 * Only two of Resend's events are Retirements, and the ones left out matter as much as the
 * ones kept. `email.delivered`, `email.opened` and `email.clicked` are engagement data the
 * platform deliberately does not hold; `email.delivery_delayed` is a transient state that
 * resolves itself.
 *
 * **A soft bounce is not a retirement.** `CONTEXT.md` says an address is retired when it "hard
 * bounced", and a full mailbox or a greylisting server is neither a wrong address nor a person
 * saying stop — retiring on one would quietly unsubscribe somebody who went on holiday.
 * Resend reports the distinction in `data.bounce.type`, and an event that does not say
 * `hard` is left alone.
 */
export type Retirement = "bounce" | "complaint";

export interface DeliveryEvent {
  readonly retirement: Retirement;
  readonly email: string;
}

interface ResendEvent {
  type?: unknown;
  data?: {
    to?: unknown;
    email?: unknown;
    bounce?: { type?: unknown };
  };
}

/**
 * Read one event, defensively: everything about the shape is somebody else's API, and a
 * surprise in it must produce "nothing to do" rather than an exception or, worse, a retirement
 * of the wrong address.
 *
 * `data.to` is an array on every send the platform makes, because `resend.ts` posts one
 * recipient per call — but it is read as either shape, since a single string is the one
 * variation that would silently retire nobody while looking like it worked.
 */
export function readDeliveryEvent(payload: unknown): DeliveryEvent | null {
  const event = payload as ResendEvent;
  const type = typeof event?.type === "string" ? event.type : null;
  if (type === null) return null;

  const recipients = event.data?.to;
  const email =
    typeof recipients === "string"
      ? recipients
      : Array.isArray(recipients) && typeof recipients[0] === "string"
        ? recipients[0]
        : typeof event.data?.email === "string"
          ? event.data.email
          : null;
  if (email === null || email.length === 0) return null;

  if (type === "email.complained") return { retirement: "complaint", email };
  if (type === "email.bounced") {
    return event.data?.bounce?.type === "hard"
      ? { retirement: "bounce", email }
      : null;
  }
  return null;
}
