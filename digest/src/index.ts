import {
  createDb,
  digestRuns,
  eraseDepartedShelters,
  findNeverMatchedSubscribers,
  pruneSentSets,
  purgeDigestDeliveries,
  recordNudge,
  runSubscriberPurges,
  subscribers,
} from "@pawster/db";
import {
  composeDigest,
  DIGEST_DAILY_BUDGET,
  digestCandidates,
  departureErasureCutoff,
  digestDeliveryPurgeCutoff,
  digestIdempotencyKey,
  manageUrl,
  neverMatchedNudgeCutoff,
  optInMailLedgerCutoff,
  optInPurgeCutoff,
  readCriteria,
  sentSetPruneCutoff,
  unsubscribeUrl,
  unsubscribedErasureCutoff,
} from "@pawster/domain";
import { asc } from "drizzle-orm";
import type { SubscriptionCriteria } from "@pawster/domain";
import type { DigestMessage, DigestSection, Env } from "./env.ts";
import { sendConfirmationNudges } from "./confirmation-nudge.ts";
import { NUDGES_PER_RUN, sendNudgeEmail } from "./nudge.ts";
import { type SweepOutcome, mailAdmin, reclaimAndMeasure, sweepAlert } from "./reclaim.ts";
import { pingWatchdog } from "./watchdog.ts";
import { renderDigestHtml } from "./email.ts";
import { sendDigestEmail } from "./resend.ts";
import {
  mailable,
  readDigestRows,
  readListedForDigest,
  readShardSentSets,
  readShardSubscriptions,
} from "./store.ts";

/**
 * The digest Worker: a `scheduled` producer and a `queue` consumer in one script, sharing
 * a D1 database with `web/` but nothing else. It is a separate Worker from `web/` so it
 * gets its own 3 MB bundle and 10 ms CPU budget, deploys independently, and — the reason
 * that matters — can be tested without booting Astro (ADR 0007).
 *
 * The run purges what retention is due, sends the ninety-day nudges that are owed, finds
 * today's shard, matches it against the listed animals, enqueues one message per subscriber
 * with something new, records the run, and pings the watchdog. Fan-out is forced by the
 * 50-subrequest and 10 ms limits, so neither handler may do unbounded work in one invocation
 * (ADR 0006): the producer does four reads however large the shard is, and each consumer
 * invocation sends one email and makes one write.
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
    const purgedDeliveries = await purgeDigestDeliveries(
      db,
      digestDeliveryPurgeCutoff(now),
    );
    const erasedDepartures = await eraseDepartedShelters(
      db,
      departureErasureCutoff(now),
    );
    // After the erasure, so a shelter departed today already counts as unlisted.
    const listed = await readListedForDigest(db);
    const prunedSentRows = await pruneSentSets(
      db,
      listed.map((animal) => animal.id),
      now,
      sentSetPruneCutoff(now),
    );

    /**
     * ADR 0016's reclamation sweep, the last preamble step. A failure anywhere in it is
     * recorded as an aborted sweep and the digest still runs: the sweep throws before it
     * deletes anything, and a skipped sweep heals itself tomorrow.
     */
    let sweep: SweepOutcome | null = null;
    try {
      sweep = await reclaimAndMeasure(env, db, now);
    } catch {
      // Recorded below as `aborted`.
    }
    let adminMails = 0;
    const alert = sweepAlert(sweep);
    if (alert !== null) {
      try {
        await mailAdmin(env, alert);
        adminMails = 1;
      } catch {
        // The run record and the watchdog ping still carry the sweep's outcome.
      }
    }

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
     * Confirmation nudges are not subtracted. They already have their own slots inside the 30
     * that `DIGEST_DAILY_BUDGET` holds back (ADR 0009, `web/src/lib/subscriber/policy.ts`).
     *
     * An unsubscribed or retired subscriber is excluded. Both are rows the platform keeps and
     * must not mail: `unsubscribed_at` is the subscriber's own decision and `retired_at` is
     * ours, and `CONTEXT.md` separates them so that neither can be read off the other. This
     * is the clause that makes the ninety-day grace period safe to have at all — without it,
     * "we keep your searches for ninety days" would mean "we keep mailing you for ninety
     * days".
     */
    const confirmationNudges = await sendConfirmationNudges(env, now);

    const [shard, searches, sentSets] = await Promise.all([
      db
        .select({
          id: subscribers.id,
          email: subscribers.email,
          manageTokenVersion: subscribers.manageTokenVersion,
        })
        .from(subscribers)
        .where(mailable(sendDay))
        .orderBy(asc(subscribers.lastDigestAt), asc(subscribers.optedInAt)),
      readShardSubscriptions(db, sendDay),
      readShardSentSets(db, sendDay),
    ]);

    /**
     * ADR 0009's candidate set, per search: matches the criteria AND currently listed AND not
     * in that search's sent-set. A subscriber with nothing new is not enqueued at all, so the
     * budget below is spent only on mail that says something.
     */
    const matchesBySubscriber = new Map<
      string,
      { subscriptionId: string; criteria: SubscriptionCriteria; units: string[][] }[]
    >();
    for (const search of searches) {
      const criteria = readCriteria(search.criteria);
      const units = digestCandidates(
        listed,
        criteria,
        sentSets.get(search.id) ?? new Set(),
        now,
      );
      if (units.length === 0) continue;
      const matches = matchesBySubscriber.get(search.subscriberId) ?? [];
      matches.push({ subscriptionId: search.id, criteria, units });
      matchesBySubscriber.set(search.subscriberId, matches);
    }

    const due = shard
      .filter((subscriber) => matchesBySubscriber.has(subscriber.id))
      .slice(0, Math.max(0, DIGEST_DAILY_BUDGET - nudged - adminMails));

    let units = 0;
    for (const subscriber of due) {
      // Chosen here rather than in the consumer, so a redelivery sends and remembers the same
      // rows. The overflow is not marked sent and comes back next week.
      const matches = matchesBySubscriber.get(subscriber.id)!;
      const sections: DigestSection[] = composeDigest(matches).map((section, i) => ({
        ...section,
        criteria: matches[i]!.criteria,
      }));
      units += sections.reduce((sum, section) => sum + section.units.length, 0);
      await env.DIGEST_QUEUE.send({
        period,
        subscriberId: subscriber.id,
        email: subscriber.email,
        manageTokenVersion: subscriber.manageTokenVersion,
        sections,
      });
    }

    /**
     * The Digest Run record (`CONTEXT.md`), written after the shard is enqueued so a run that
     * throws half-way leaves no row claiming it finished. ADR 0010 asks the purges to write
     * their counts here, and they do: a purge that silently stopped finding rows looks exactly
     * like a purge with nothing to do, and these numbers are what tell them apart.
     */
    const run = {
      period,
      shard: shard.length,
      enqueued: due.length,
      units,
      nudged,
      purgedOptIns: purged.optIns,
      purgedOptInMails: purged.mailLedger,
      erasedSubscribers: purged.erasedSubscribers,
      purgedDeliveries,
      erasedDepartures,
      prunedSentRows,
      sweep: sweep?.sweep ?? ("aborted" as const),
      reclaimedObjects: sweep?.reclaimedObjects ?? 0,
      reclaimedBytes: sweep?.reclaimedBytes ?? 0,
      storedBytes: sweep?.storedBytes ?? null,
    };
    await db.insert(digestRuns).values({ ...run, ranAt: now });

    /**
     * At completion, per run, not per batch (ADR 0009): a check per batch turns a quiet
     * day into a false alarm. This line is reached only after every message is enqueued,
     * so a run that throws half-way never reports success and the grace period expires —
     * which is the alarm. `waitUntil` keeps the ping off the critical path without
     * changing that, because a ping registered here was already earned.
     */
    ctx.waitUntil(pingWatchdog(env.HEALTHCHECK_URL, "success", { ...run, confirmationNudges }));
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
        const { period, subscriberId, sections } = message.body;
        const unsubscribe = await unsubscribeUrl(env, subscriberId);
        const html = await renderDigestHtml({
          sections,
          animals: await readDigestRows(
            db,
            sections.flatMap((section) => section.units.flat()),
          ),
          // The period, not the clock: a redelivery tomorrow must render the same bytes.
          asOf: new Date(period),
          siteOrigin: env.SITE_ORIGIN,
          mediaBase: env.MEDIA_BASE_URL,
          manageUrl: await manageUrl(env, {
            subscriberId,
            version: message.body.manageTokenVersion,
          }),
          unsubscribeUrl: unsubscribe,
        });
        await sendDigestEmail(env, {
          to: message.body.email,
          // Deterministic and per-recipient: a redelivered message is a no-op for anyone
          // already sent, and a resumed run neither 409s nor re-sends the whole shard.
          idempotencyKey: digestIdempotencyKey(
            message.body.period,
            message.body.subscriberId,
          ),
          html,
          // Signed, because the link is the subscriber's whole credential (CONTEXT.md).
          unsubscribeUrl: unsubscribe,
        });
        // Only after the send actually succeeded: the sent-set is what makes tomorrow's
        // candidates exclude these animals, and a dropped message writes nothing, so the next
        // run simply recomputes it. `lastDigestAt` is ADR 0009's reporting field; it orders
        // the next shard's overflow and is never asked what is "new".
        const sentAt = new Date();
        const remember = env.DB.prepare(
          // Guarded by EXISTS rather than trusted: the search can be deleted from the manage
          // page, or the animal removed, between enqueue and send, and a foreign-key failure
          // here would retry an email that already went out.
          `insert or ignore into digest_sent (subscription_id, animal_id, sent_at)
           select ?1, ?2, ?3
           where exists (select 1 from subscriptions where id = ?1)
             and exists (select 1 from animals where id = ?2)`,
        );
        await env.DB.batch([
          env.DB.prepare(
            "update subscribers set last_digest_at = ? where id = ?",
          ).bind(sentAt.getTime(), message.body.subscriberId),
          // The Digest Delivery (`CONTEXT.md`): the subscriber's id and never the address,
          // kept 90 days by the preamble. Guarded for the same reason as the sent-set rows.
          env.DB.prepare(
            `insert into digest_deliveries (id, subscriber_id, period, sent_at)
             select ?1, ?2, ?3, ?4 where exists (select 1 from subscribers where id = ?2)`,
          ).bind(
            crypto.randomUUID(),
            message.body.subscriberId,
            message.body.period,
            sentAt.getTime(),
          ),
          ...message.body.sections.flatMap((section) =>
            [...section.units, ...section.repeats]
              .flat()
              .map((animalId) =>
                remember.bind(section.subscriptionId, animalId, sentAt.getTime()),
              ),
          ),
        ]);
        message.ack();
      } catch {
        // Let Queues retry, then dead-letter. The sent-set — not the message — is the
        // source of truth for who has been sent to, so a retry is safe.
        message.retry();
      }
    }
  },
};
