import type { APIRoute } from "astro";
import { createDb } from "@pawster/db";
import { env } from "cloudflare:workers";
import { doNotContactCanary, doNotContactDigest } from "../../../lib/subscriber/crypto.ts";
import {
  findSubscriberByEmail,
  retireSubscriber,
} from "../../../lib/subscriber/manage.ts";
import {
  assertPepperUnchanged,
  refuseContact,
} from "../../../lib/subscriber/store.ts";
import {
  readDeliveryEvent,
  readSignedDelivery,
  verifyDelivery,
} from "../../../lib/subscriber/webhook.ts";

export const prerender = false;

/**
 * Resend's delivery webhook, and the only thing that creates a Retirement.
 *
 * `CONTEXT.md`, *Retirement*: "the platform's own decision to stop sending to a subscriber,
 * because the address hard-bounced or its owner reported us as spam. Distinct from
 * unsubscribing, which is the subscriber's decision. A complaint retirement is permanent; a
 * bounce retirement is not."
 *
 * ## Why the platform keeps this at all, when Resend already suppresses
 *
 * Issue #62 gives the reason in one clause: **"a suppressed send still spends quota."** Left
 * to the provider, a bounced address stays in the shard, gets enqueued, gets posted to
 * `/emails`, and is dropped at the far end — having spent one of a hundred messages a day.
 * The row is what keeps it out of the shard in the first place.
 *
 * And the ticket's other half: **we deliberately do not mirror subscribers into Resend
 * Contacts.** "Consent is the one piece of state that must have a single owner." Two systems
 * that both believe they know whether somebody is subscribed will disagree, and the one
 * holding the answer must be the one the digest reads.
 *
 * ## What a complaint earns and a bounce does not
 *
 * A complaint writes a Do-Not-Contact entry and is permanent; a bounce writes none. ADR 0010:
 * "a hard bounce is self-healing — opt-in completes only if the mailbox works — and Resend
 * re-suppresses bounces account-wide anyway". Somebody whose mailbox was full and was fixed
 * can sign up again; somebody who reported us as spam has said something we should not make
 * them say twice.
 *
 * ## The answer is 200 almost regardless, and that is deliberate
 *
 * A webhook that returns an error gets retried, and there is nothing here worth retrying: an
 * event for an address we have never heard of is not a failure, and neither is an event type
 * we ignore. The one 4xx is an unverified signature, because that genuinely is a caller who
 * should stop.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const delivery = readSignedDelivery(request, body);
  const now = new Date();

  /**
   * The signature is the whole of the authorisation. Without it this route retires any address
   * a caller names — a way to silently cut off every subscriber on the platform, one `POST` at
   * a time, from the open internet.
   */
  if (delivery === null || !(await verifyDelivery(env, delivery, now))) {
    return new Response(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    // Signed by Resend and still unparseable is not a thing a retry fixes.
    return new Response(null, { status: 200 });
  }

  const event = readDeliveryEvent(payload);
  if (event === null) return new Response(null, { status: 200 });

  const db = createDb(env.DB);

  /**
   * The pepper canary, before anything is written.
   *
   * This route is one of the two that can write `do_not_contact`, and ADR 0010's failure mode
   * is that a wrong pepper "silently stops matching and the platform resumes mailing people
   * who reported it as spam, with no alarm anywhere". Writing a complaint entry under the
   * wrong pepper is the version of that failure which *creates* the bad data rather than
   * merely failing to read it, so the check belongs ahead of the write rather than only on the
   * signup path that reads it.
   */
  await assertPepperUnchanged(db, await doNotContactCanary(env), now);

  const subscriber = await findSubscriberByEmail(db, event.email);

  /**
   * A complaint earns a Do-Not-Contact entry **whether or not the address is still a
   * subscriber**, and that ordering is the point rather than an edge case. The entry is what
   * survives erasure, so somebody who complained and then deleted everything — or whose row
   * the ninety-day purge already took — must still be refused by the signup form. Writing it
   * only for rows we can still find would lose exactly the people most emphatic about not
   * hearing from us.
   */
  if (event.retirement === "complaint") {
    await refuseContact(db, await doNotContactDigest(env, event.email), now);
  }

  if (subscriber !== null) {
    await retireSubscriber(db, subscriber.id, event.retirement, now);
  }

  return new Response(null, { status: 200 });
};
