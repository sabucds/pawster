import { createDb, subscribers } from "@pawster/db";
import { DIGEST_DAILY_BUDGET, digestIdempotencyKey } from "@pawster/domain";
import { eq } from "drizzle-orm";
import type { DigestMessage, Env } from "./env.ts";
import { pingWatchdog } from "./watchdog.ts";
import { sendDigestEmail } from "./resend.ts";

/**
 * The digest Worker: a `scheduled` producer and a `queue` consumer in one script, sharing
 * a D1 database with `web/` but nothing else. It is a separate Worker from `web/` so it
 * gets its own 3 MB bundle and 10 ms CPU budget, deploys independently, and — the reason
 * that matters — can be tested without booting Astro (ADR 0007).
 *
 * The skeleton's run is deliberately thin: it finds today's shard, enqueues one message
 * per subscriber, and hands the watchdog its `/start`. What is settled here is the shape —
 * fan-out is forced by the 50-subrequest and 10 ms limits, so neither handler may do
 * unbounded work in one invocation (ADR 0006). Matching animals to subscriptions is the
 * next ticket's job and slots into `queue()` below.
 */

/** `YYYY-MM-DD` in UTC. The unit of scheduling, of retry, and of the record kept after. */
export function periodOf(scheduledTime: number): string {
  return new Date(scheduledTime).toISOString().slice(0, 10);
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const period = periodOf(controller.scheduledTime);
    const sendDay = new Date(controller.scheduledTime).getUTCDay();

    const db = createDb(env.DB);
    const shard = await db
      .select({ id: subscribers.id, email: subscribers.email })
      .from(subscribers)
      .where(eq(subscribers.sendDay, sendDay))
      .limit(DIGEST_DAILY_BUDGET);

    for (const subscriber of shard) {
      await env.DIGEST_QUEUE.send({
        period,
        subscriberId: subscriber.id,
        email: subscriber.email,
      });
    }

    // Per run, not per batch: a check per batch turns a quiet day into a false alarm.
    ctx.waitUntil(
      pingWatchdog(env.HEALTHCHECK_URL, "start", {
        period,
        subscribers: shard.length,
      }),
    );
  },

  async queue(
    batch: MessageBatch<DigestMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // One handler, two queues. `batch.queue` is what tells them apart, so the dead-letter
    // consumer needs no second Worker and no second deploy.
    if (batch.queue.endsWith("-dlq")) {
      await pingWatchdog(env.HEALTHCHECK_URL, "fail", {
        deadLettered: batch.messages.length,
      });
      for (const message of batch.messages) message.ack();
      return;
    }

    for (const message of batch.messages) {
      try {
        await sendDigestEmail(env, {
          to: message.body.email,
          // Deterministic and per-recipient: a redelivered message is a no-op for anyone
          // already sent, and a resumed run neither 409s nor re-sends the whole shard.
          idempotencyKey: digestIdempotencyKey(
            message.body.period,
            message.body.subscriberId,
          ),
          period: message.body.period,
        });
        message.ack();
      } catch {
        // Let Queues retry, then dead-letter. The sent-set — not the message — is the
        // source of truth for who has been sent to, so a retry is safe.
        message.retry();
      }
    }
  },
};
