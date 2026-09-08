import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { createDb, subscribers } from "@pawster/db";
import { OPT_IN_TTL_MS, OPT_IN_WINDOW_MS, digestIdempotencyKey } from "@pawster/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyUnsubscribeToken } from "../src/unsubscribe.ts";
import { outbound } from "../../test/outbound.ts";
import type { DigestMessage } from "../src/env.ts";
import worker from "../src/index.ts";

/**
 * `scheduled()` is invoked through the Worker's own loopback service binding — the same
 * path a Cron Trigger takes — rather than by calling the exported handler directly.
 * `exports.default` from `cloudflare:workers` is the current spelling; `SELF.scheduled()`
 * from `cloudflare:test` is the older one and throws `DataCloneError` in
 * `@cloudflare/vitest-plugin@1.1.4`. See `docs/testing-seams.md`.
 */
/**
 * The runtime accepts `scheduled()` on a loopback stub; the published `Fetcher` type
 * declares only `fetch` and `connect`, so the shape has to be spelled out here.
 */
type ScheduledInvocable = {
  scheduled(options: { scheduledTime: Date | number; cron?: string }): Promise<{
    outcome: string;
  }>;
};

const runScheduled = (scheduledTime: Date) =>
  (workerExports.default as unknown as ScheduledInvocable).scheduled({
    scheduledTime,
  });

/** A Wednesday, so `getUTCDay()` is 3. */
const WEDNESDAY = new Date(Date.UTC(2026, 8, 2, 11, 0, 0));

const message = (id: string, body: DigestMessage) => ({
  id,
  timestamp: WEDNESDAY,
  attempts: 1,
  body,
});

const WED_MESSAGE = message("m1", {
  period: "2026-09-02",
  subscriberId: "s-wed",
  email: "wed@example.org",
});

/**
 * Deliver one batch to the consumer. `getQueueResult` only *reads* the ack/retry state a
 * batch ended up in — it does not invoke the handler — so the handler call has to be
 * explicit, and the two share the same `ExecutionContext`.
 */
async function deliver(queue: string, messages: ReturnType<typeof message>[]) {
  const batch = createMessageBatch<DigestMessage>(queue, messages);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

async function seedSubscriber(
  id: string,
  email: string,
  sendDay: number,
  waiting: { optedInAt?: Date; lastDigestAt?: Date | null } = {},
) {
  await createDb(env.DB)
    .insert(subscribers)
    .values({
      id,
      email,
      sendDay,
      optedInAt: waiting.optedInAt ?? new Date(0),
      lastDigestAt: waiting.lastDigestAt ?? null,
    });
}

/**
 * Run `scheduled()` with a capturing queue in place of the real binding, so the *order* it
 * enqueued the shard in can be asserted. The real `DIGEST_QUEUE` accepts messages but
 * offers no way to read back what was sent, and the order is the whole point of ADR 0009's
 * "longest-waiting" rule.
 */
async function enqueuedBy(scheduledTime: Date): Promise<DigestMessage[]> {
  const sent: DigestMessage[] = [];
  const ctx = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ scheduledTime }),
    {
      ...env,
      DIGEST_QUEUE: {
        send: async (message: DigestMessage) => {
          sent.push(message);
        },
      },
    } as unknown as Parameters<typeof worker.scheduled>[1],
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return sent;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM subscribers");
  await env.DB.exec("DELETE FROM pending_opt_ins");
  await env.DB.exec("DELETE FROM opt_in_mails");
});

describe("scheduled()", () => {
  it("runs the handler and the watchdog ping is visible in the interceptor's call log", async () => {
    await runScheduled(WEDNESDAY);

    const pings = outbound.callsTo("healthchecks");
    expect(pings).toHaveLength(1);
    // The *bare* check URL, which is Healthchecks.io's success endpoint: ADR 0009 asks for
    // one ping per daily run at completion. A `/start` ping would leave the check
    // permanently un-completed and alarm every day.
    expect(pings[0]!.url).toBe(env.HEALTHCHECK_URL);
    expect(JSON.parse(pings[0]!.body!)).toMatchObject({ period: "2026-09-02" });
  });

  it("enqueues only the subscribers whose send day it is", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedSubscriber("s-thu", "thu@example.org", 4);

    await runScheduled(WEDNESDAY);

    const ping = outbound.callsTo("healthchecks").at(-1)!;
    expect(JSON.parse(ping.body!)).toMatchObject({
      period: "2026-09-02",
      subscribers: 1,
    });
  });

  it("survives a watchdog that is down, because a monitoring outage is not a delivery outage", async () => {
    outbound.on("healthchecks", () => new Response("nope", { status: 500 }));

    await expect(runScheduled(WEDNESDAY)).resolves.not.toThrow();
  });

  it("reads D1 through a client built inside the handler, not one cached at module scope", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);

    // Two invocations of the same isolate. This is the shape a cached client breaks in —
    // but note it would *not* break here: `db/test/module-scope-is-wrong.test.ts` measures
    // the runtime staying silent about exactly that, which is why the rule is enforced by
    // `scripts/check-source-rules.mjs` and not by this test.
    await runScheduled(WEDNESDAY);
    await runScheduled(WEDNESDAY);

    expect(outbound.callsTo("healthchecks")).toHaveLength(2);
  });
});

/**
 * The purge preamble ADR 0010 puts inside this Cron Trigger: "the purges run as a preamble to
 * the daily digest run, inside the same Cron Trigger and under the same Healthchecks.io
 * watchdog… a retention policy with no job behind it is a lie, and a second schedule would be
 * a second thing that can die silently."
 *
 * Tested here rather than only against the query, because the query passing proves nothing
 * about the obligation: an unwired purge is exactly the lie that sentence is about, and what
 * makes the retention real is that *this handler* calls it.
 */
describe("the retention preamble", () => {
  /** One unconfirmed opt-in, aged by `age` milliseconds. Carries the only IP in the model. */
  async function seedPendingOptIn(tokenHash: string, age: number) {
    await env.DB.prepare(
      "INSERT INTO pending_opt_ins (token_hash, email, criteria, locale, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(tokenHash, "ana@adoptante.example", "{}", "es", "ip-fingerprint", WEDNESDAY.getTime() - age)
      .run();
  }

  async function seedOptInMail(id: string, age: number) {
    await env.DB.prepare(
      "INSERT INTO opt_in_mails (id, email_hash, sent_at) VALUES (?, ?, ?)",
    )
      .bind(id, "address-fingerprint", WEDNESDAY.getTime() - age)
      .run();
  }

  const countIn = async (table: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

  it("destroys an unconfirmed opt-in past its seven days, and its IP with it", async () => {
    await seedPendingOptIn("expired", OPT_IN_TTL_MS + 60_000);
    await seedPendingOptIn("fresh", OPT_IN_TTL_MS - 60_000);

    await runScheduled(WEDNESDAY);

    const { results } = await env.DB.prepare(
      "SELECT token_hash FROM pending_opt_ins",
    ).all<{ token_hash: string }>();

    // The IP lives on this row and nowhere else (ADR 0010), so destroying the row is what
    // destroys the IP — there is no second delete to remember.
    expect(results.map((row) => row.token_hash)).toEqual(["fresh"]);
  });

  it("drops mail-ledger rows past the window they serve, on a shorter clock", async () => {
    /**
     * The asymmetry is ADR 0010's rule that every period is derived from what the record is
     * for. A ledger row answers the global ceiling and the per-address cooldown, both bounded
     * by 24 hours, so a row a day old answers nothing — and keeping it for seven days to
     * match its neighbour would be retention by symmetry.
     */
    await seedOptInMail("stale", OPT_IN_WINDOW_MS + 60_000);
    await seedOptInMail("counted", OPT_IN_WINDOW_MS - 60_000);

    await runScheduled(WEDNESDAY);

    const { results } = await env.DB.prepare("SELECT id FROM opt_in_mails").all<{
      id: string;
    }>();
    expect(results.map((row) => row.id)).toEqual(["counted"]);
  });

  it("reports what it destroyed to the watchdog", async () => {
    /**
     * ADR 0010 asks the purges to write "their counts into the `Digest Run` summary"; that
     * table does not exist yet and the ping's detail body is the record that does. The
     * reporting is the point rather than the destination — a purge that silently stopped
     * finding rows looks exactly like a purge with nothing to do.
     */
    await seedPendingOptIn("expired", OPT_IN_TTL_MS + 60_000);
    await seedOptInMail("stale", OPT_IN_WINDOW_MS + 60_000);

    await runScheduled(WEDNESDAY);

    const [ping] = outbound.callsTo("healthchecks");
    expect(JSON.parse(ping!.body!)).toMatchObject({
      purgedOptIns: 1,
      purgedOptInMails: 1,
    });
  });

  it("purges before enqueuing, so a shard that fails still leaves retention done", async () => {
    /**
     * A preamble and not an epilogue. The digest's own work can be cut short — by the shard
     * budget, or by an enqueue that throws — and retention is the half with a legal
     * obligation behind it, so it must not be downstream of the half that can fail.
     */
    await seedPendingOptIn("expired", OPT_IN_TTL_MS + 60_000);
    await seedSubscriber("s-wed", "wed@example.org", 3);

    const ctx = createExecutionContext();
    await expect(
      worker.scheduled(
        createScheduledController({ scheduledTime: WEDNESDAY }),
        {
          ...env,
          DIGEST_QUEUE: {
            send: async () => {
              throw new Error("the queue is down");
            },
          },
        } as unknown as Parameters<typeof worker.scheduled>[1],
        ctx,
      ),
    ).rejects.toThrow(/queue is down/);

    expect(await countIn("pending_opt_ins")).toBe(0);
  });
});

describe("the shard's ordering", () => {
  it("puts the longest-waiting subscribers first, so the budget's overflow rotates", async () => {
    // All three share a send day, so all three are in the same shard; only the ordering
    // decides who survives a truncation at DIGEST_DAILY_BUDGET.
    await seedSubscriber("s-recent", "recent@example.org", 3, {
      lastDigestAt: new Date("2026-09-01"),
    });
    await seedSubscriber("s-never", "never@example.org", 3, {
      lastDigestAt: null,
    });
    await seedSubscriber("s-stale", "stale@example.org", 3, {
      lastDigestAt: new Date("2026-06-01"),
    });

    const enqueued = await enqueuedBy(WEDNESDAY);

    // Never-sent first (NULLs sort first in SQLite), then longest-since-sent. Without the
    // `orderBy` this came back in insertion order and `s-recent` outranked `s-never`.
    expect(enqueued.map((m) => m.subscriberId)).toEqual([
      "s-never",
      "s-stale",
      "s-recent",
    ]);
  });

  it("breaks a tie on opt-in time, so the order is stable rather than arbitrary", async () => {
    await seedSubscriber("s-later", "later@example.org", 3, {
      optedInAt: new Date("2026-05-01"),
    });
    await seedSubscriber("s-earlier", "earlier@example.org", 3, {
      optedInAt: new Date("2026-01-01"),
    });

    const enqueued = await enqueuedBy(WEDNESDAY);

    expect(enqueued.map((m) => m.subscriberId)).toEqual([
      "s-earlier",
      "s-later",
    ]);
  });
});

describe("queue()", () => {
  it("sends exactly one email per recipient under a deterministic idempotency key", async () => {
    const result = await deliver("pawster-digest", [WED_MESSAGE]);

    expect(result.outcome).toBe("ok");
    expect(result.retryBatch.retry).toBe(false);

    const emails = outbound.callsTo("resend");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.url).toBe("https://api.resend.com/emails");
    expect(emails[0]!.headers["idempotency-key"]).toBe(
      digestIdempotencyKey("2026-09-02", "s-wed"),
    );

    const payload = JSON.parse(emails[0]!.body!);
    expect(payload.to).toEqual(["wed@example.org"]);
    // We host the entire unsubscribe flow ourselves (ADR 0009).
    expect(payload.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
  });

  it("carries an unsubscribe link that is signed, not a guessable subscriber id", async () => {
    await deliver("pawster-digest", [WED_MESSAGE]);

    const payload = JSON.parse(outbound.callsTo("resend")[0]!.body!);
    const link: string = payload.headers["List-Unsubscribe"].slice(1, -1);

    // The origin is configuration, not a literal in the source (ADR 0014).
    expect(link.startsWith(`${env.SITE_ORIGIN}/unsubscribe/`)).toBe(true);

    const token = link.slice(`${env.SITE_ORIGIN}/unsubscribe/`.length);
    // A Subscription is "managed entirely through signed links" (CONTEXT.md), so the token
    // has to carry a MAC the route can check — the id alone would let anyone who guesses
    // an id unsubscribe a stranger.
    expect(token).not.toBe("s-wed");
    await expect(
      verifyUnsubscribeToken(env, token),
    ).resolves.toBe("s-wed");

    // And the signature has to be load-bearing: flip one character of the id and the token
    // must stop verifying rather than being trusted for whoever it now names.
    await expect(
      verifyUnsubscribeToken(env, token.replace("s-wed.", "s-xxx.")),
    ).resolves.toBeNull();
  });

  it("records the send as ADR 0009's reporting field, so tomorrow's shard can order by it", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);

    await deliver("pawster-digest", [WED_MESSAGE]);

    const [row] = await createDb(env.DB)
      .select({ lastDigestAt: subscribers.lastDigestAt })
      .from(subscribers)
      .where(eq(subscribers.id, "s-wed"));
    expect(row!.lastDigestAt).toBeInstanceOf(Date);
  });

  it("leaves lastDigestAt untouched when the send failed", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    outbound.on("resend", () => new Response("rate limited", { status: 429 }));

    await deliver("pawster-digest", [WED_MESSAGE]);

    const [row] = await createDb(env.DB)
      .select({ lastDigestAt: subscribers.lastDigestAt })
      .from(subscribers)
      .where(eq(subscribers.id, "s-wed"));
    // Otherwise a failed send would push the subscriber to the back of tomorrow's queue —
    // the retry and the ordering would fight each other.
    expect(row!.lastDigestAt).toBeNull();
  });

  it("retries rather than acking when Resend rejects the send", async () => {
    outbound.on("resend", () => new Response("rate limited", { status: 429 }));

    const result = await deliver("pawster-digest", [WED_MESSAGE]);

    // Note the field is `msgId`, not `messageId`.
    expect(result.retryMessages).toEqual([{ msgId: "m1" }]);
  });

  it("pings /fail from the dead-letter queue's consumer and re-sends nothing", async () => {
    await deliver("pawster-digest-dlq", [WED_MESSAGE]);

    const pings = outbound.callsTo("healthchecks");
    expect(pings).toHaveLength(1);
    expect(pings[0]!.url).toBe(`${env.HEALTHCHECK_URL}/fail`);
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });
});

describe("the handler in isolation", () => {
  it("derives the period from the scheduled time, in UTC", async () => {
    const controller = createScheduledController({
      scheduledTime: new Date(Date.UTC(2026, 11, 31, 23, 59)),
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(JSON.parse(outbound.callsTo("healthchecks")[0]!.body!)).toMatchObject(
      { period: "2026-12-31" },
    );
  });
});
