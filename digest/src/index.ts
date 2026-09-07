import { createDb, subscribers } from "@pawster/db";
import { DIGEST_DAILY_BUDGET, digestIdempotencyKey } from "@pawster/domain";
import { asc, eq } from "drizzle-orm";
import type { DigestMessage, Env } from "./env.ts";
import { pingWatchdog } from "./watchdog.ts";
import { sendDigestEmail } from "./resend.ts";
import { unsubscribeUrl } from "./unsubscribe.ts";

/**
 * The digest Worker: a `scheduled` producer and a `queue` consumer in one script, sharing
 * a D1 database with `web/` but nothing else. It is a separate Worker from `web/` so it
 * gets its own 3 MB bundle and 10 ms CPU budget, deploys independently, and — the reason
 * that matters — can be tested without booting Astro (ADR 0007).
 *
 * The skeleton's run is deliberately thin: it finds today's shard, enqueues one message
 * per subscriber, and pings the watchdog once the shard is enqueued. What is settled here
 * is the shape —
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
    /**
     * "A shard that exceeds its budget sends its longest-waiting subscribers and defers
     * the rest to tomorrow" (ADR 0009). The ordering is the whole of that sentence: with a
     * bare `limit`, D1 returns whichever rows it likes and the same unlucky tail is
     * deferred every single day, which is starvation rather than deferral. `last_digest_at
     * ASC` sorts NULLs first in SQLite, so subscribers who have never received a digest go
     * first, then the longest-since-sent, with opt-in time as a stable tiebreak.
     */
    const shard = await db
      .select({ id: subscribers.id, email: subscribers.email })
      .from(subscribers)
      .where(eq(subscribers.sendDay, sendDay))
      .orderBy(asc(subscribers.lastDigestAt), asc(subscribers.optedInAt))
      .limit(DIGEST_DAILY_BUDGET);

    for (const subscriber of shard) {
      await env.DIGEST_QUEUE.send({
        period,
        subscriberId: subscriber.id,
        email: subscriber.email,
      });
    }

    /**
     * At completion, per run, not per batch (ADR 0009): a check per batch turns a quiet
     * day into a false alarm. This line is reached only after every message is enqueued,
     * so a run that throws half-way never reports success and the grace period expires —
     * which is the alarm. `waitUntil` keeps the ping off the critical path without
     * changing that, because a ping registered here was already earned.
     */
    ctx.waitUntil(
      pingWatchdog(env.HEALTHCHECK_URL, "success", {
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

    const db = createDb(env.DB);

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
          // Signed, because the link is the subscriber's whole credential (CONTEXT.md).
          unsubscribeUrl: await unsubscribeUrl(env, message.body.subscriberId),
        });
        // Only after the send actually succeeded, and only as ADR 0009's reporting field:
        // it orders the next shard's overflow and is never asked what is "new".
        await db
          .update(subscribers)
          .set({ lastDigestAt: new Date() })
          .where(eq(subscribers.id, message.body.subscriberId));
        message.ack();
      } catch {
        // Let Queues retry, then dead-letter. The sent-set — not the message — is the
        // source of truth for who has been sent to, so a retry is safe.
        message.retry();
      }
    }
  },
};
