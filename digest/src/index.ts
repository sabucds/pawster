import {
  createDb,
  findNeverMatchedSubscribers,
  recordNudge,
  runSubscriberPurges,
  subscribers,
} from "@pawster/db";
import {
  DIGEST_DAILY_BUDGET,
  digestIdempotencyKey,
  neverMatchedNudgeCutoff,
  optInMailLedgerCutoff,
  optInPurgeCutoff,
  unsubscribeUrl,
  unsubscribedErasureCutoff,
} from "@pawster/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { DigestMessage, Env } from "./env.ts";
import { NUDGES_PER_RUN, sendNudgeEmail } from "./nudge.ts";
import { pingWatchdog } from "./watchdog.ts";
import { sendDigestEmail } from "./resend.ts";

/**
 * The digest Worker: a `scheduled` producer and a `queue` consumer in one script, sharing
 * a D1 database with `web/` but nothing else. It is a separate Worker from `web/` so it
 * gets its own 3 MB bundle and 10 ms CPU budget, deploys independently, and — the reason
 * that matters — can be tested without booting Astro (ADR 0007).
 *
 * The run is deliberately thin: it purges what retention is due, sends the ninety-day nudges
 * that are owed, finds today's shard, enqueues one message per subscriber, and pings the
 * watchdog once the shard is enqueued. What is settled here is the shape — fan-out is forced
 * by the 50-subrequest and 10 ms limits, so neither handler may do unbounded work in one
 * invocation (ADR 0006). Matching animals to subscriptions is the next ticket's job and slots
 * into `queue()` below.
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
    const now = new Date(controller.scheduledTime);
    const sendDay = now.getUTCDay();

    const db = createDb(env.DB);

    /**
     * Retention first, before a single message is enqueued.
     *
     * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) puts the purges here and
     * says why it is here rather than on a schedule of its own: "a retention policy with no
     * job behind it is a lie, and a second schedule would be a second thing that can die
     * silently." Sharing this trigger means the purges are covered by the same watchdog as
     * the digest, so a run that stops purging is a run that stops reporting.
     *
     * A **preamble** and not an epilogue, deliberately. The digest's own work can be cut
     * short by the shard budget or by an enqueue that throws, and retention is the half with
     * a legal obligation behind it — an unconfirmed opt-in is an address the platform holds
     * no consent for at all, and an unsubscribed subscriber past ninety days is a row the
     * platform promised to destroy. So it runs while there is certainly budget left.
     *
     * The 10 ms CPU ceiling is not a constraint on a handful of database-side `DELETE`s, and
     * lag equals the run's own lag, which periods of 1, 7 and 90 days absorb without harm.
     */
    const purged = await runSubscriberPurges(db, {
      optIns: optInPurgeCutoff(now),
      mailLedger: optInMailLedgerCutoff(now),
      unsubscribed: unsubscribedErasureCutoff(now),
    });

    /**
     * The ninety-day "still nothing" nudge, and it runs **before** the shard for the same
     * reason retention does: it is the half with an obligation behind it.
     *
     * ADR 0010 leans on this mail to guarantee "a live link at least quarterly" for a
     * subscriber who never matches anything, because the manage page is the subject-access
     * response and the digest footer is the only other place its link appears. A run that
     * spent its whole budget on digests and skipped these would leave exactly the subscribers
     * who get no digest with no route to their own data.
     *
     * Each send is attempted independently and a failure is swallowed: the nudge is a
     * courtesy owed to one subscriber, and one address that Resend refuses must not take the
     * day's digests down with it. `nudged_at` is written only after a send succeeds, so the
     * failures are simply retried tomorrow.
     */
    const owed = await findNeverMatchedSubscribers(
      db,
      neverMatchedNudgeCutoff(now),
      NUDGES_PER_RUN,
    );
    let nudged = 0;
    for (const subscriber of owed) {
      try {
        await sendNudgeEmail(env, {
          to: subscriber.email,
          subscriberId: subscriber.id,
          manageTokenVersion: subscriber.manageTokenVersion,
        });
        await recordNudge(db, subscriber.id, now);
        nudged++;
      } catch {
        // Left unmarked on purpose, so the next run tries this subscriber again.
      }
    }

    /**
     * "A shard that exceeds its budget sends its longest-waiting subscribers and defers
     * the rest to tomorrow" (ADR 0009). The ordering is the whole of that sentence: with a
     * bare `limit`, D1 returns whichever rows it likes and the same unlucky tail is
     * deferred every single day, which is starvation rather than deferral. `last_digest_at
     * ASC` sorts NULLs first in SQLite, so subscribers who have never received a digest go
     * first, then the longest-since-sent, with opt-in time as a stable tiebreak.
     *
     * **The limit is the day's budget less whatever the nudges just spent.** Resend's
     * hundred-a-day is already divided to the last message
     * (`web/src/lib/subscriber/policy.ts`), so the nudges have no allowance of their own and
     * take the slots the digest would have used — which is exactly right, since every
     * recipient of one is a subscriber the digest is not reaching. Subtracting here is what
     * makes "the run sends at most `DIGEST_DAILY_BUDGET` messages" true whatever the mix.
     *
     * An unsubscribed or retired subscriber is excluded. Both are rows the platform keeps and
     * must not mail: `unsubscribed_at` is the subscriber's own decision and `retired_at` is
     * ours, and `CONTEXT.md` separates them so that neither can be read off the other. This
     * is the clause that makes the ninety-day grace period safe to have at all — without it,
     * "we keep your searches for ninety days" would mean "we keep mailing you for ninety
     * days".
     */
    const shard = await db
      .select({ id: subscribers.id, email: subscribers.email })
      .from(subscribers)
      .where(
        and(
          eq(subscribers.sendDay, sendDay),
          isNull(subscribers.unsubscribedAt),
          isNull(subscribers.retiredAt),
        ),
      )
      .orderBy(asc(subscribers.lastDigestAt), asc(subscribers.optedInAt))
      .limit(Math.max(0, DIGEST_DAILY_BUDGET - nudged));

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
        /**
         * ADR 0010 asks the purges to write "their counts into the `Digest Run` summary".
         * That table does not exist yet, and the ping's detail body is the record that does —
         * so the counts go here until it lands. It is the reporting that matters rather than
         * the destination: a purge that silently stopped finding rows looks exactly like a
         * purge with nothing to do, and these numbers are the only thing that tells them
         * apart.
         */
        purgedOptIns: purged.optIns,
        purgedOptInMails: purged.mailLedger,
        erasedSubscribers: purged.erasedSubscribers,
        nudged,
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
