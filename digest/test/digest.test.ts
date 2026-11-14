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
import {
  DIGEST_DAILY_BUDGET,
  MANAGE_PATH,
  OPT_IN_TTL_MS,
  OPT_IN_WINDOW_MS,
  UNSUBSCRIBE_PATH,
  digestIdempotencyKey,
  verifyManageToken,
  verifyUnsubscribeToken,
} from "@pawster/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { derivativeKey } from "@pawster/web/src/lib/photos/keys.ts";
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
  manageTokenVersion: 0,
  sections: [],
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
  waiting: {
    optedInAt?: Date;
    lastDigestAt?: Date | null;
    unsubscribedAt?: Date | null;
    retiredAt?: Date | null;
    retirementReason?: "bounce" | "complaint" | null;
    nudgedAt?: Date | null;
    manageTokenVersion?: number;
  } = {},
) {
  await createDb(env.DB)
    .insert(subscribers)
    .values({
      id,
      email,
      sendDay,
      optedInAt: waiting.optedInAt ?? new Date(0),
      lastDigestAt: waiting.lastDigestAt ?? null,
      unsubscribedAt: waiting.unsubscribedAt ?? null,
      retiredAt: waiting.retiredAt ?? null,
      retirementReason: waiting.retirementReason ?? null,
      nudgedAt: waiting.nudgedAt ?? null,
      manageTokenVersion: waiting.manageTokenVersion ?? 0,
    });
}

/** A section that shows exactly these units, with nothing repeated and nothing left over. */
function shown(subscriptionId: string, units: string[][]) {
  return expect.objectContaining({ subscriptionId, units, repeats: [], more: 0 });
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

/**
 * A verified shelter with a public contact point: the two shelter-level clauses of the listing
 * rule. Raw SQL because `digest/` has no route that creates either, and the suites that do
 * create them live in `web/`.
 */
async function seedShelter(id = "shelter-1") {
  const at = new Date("2026-08-01").getTime();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO shelters (id, slug, display_name, account_email, base_region, country_code, created_at) VALUES (?, ?, ?, ?, 'Miranda', 'VE', ?)",
    ).bind(id, id, `Refugio ${id}`, `${id}@example.org`, at),
    env.DB.prepare(
      "INSERT INTO shelter_contact_points (id, shelter_id, kind, value, position, created_at) VALUES (?, ?, 'whatsapp', '+58 412 5550001', 0, ?)",
    ).bind(`${id}-cp`, id, at),
    env.DB.prepare(
      "INSERT INTO verifications (shelter_id, outcome, methods, evidence, decided_at, decided_by, cited_display_name, cited_contact_points) VALUES (?, 'Verified', 'call', 'seen', ?, 'admin@example.org', ?, '[]')",
    ).bind(id, at, `Refugio ${id}`),
  ]);
}

interface AnimalSeed {
  readonly species?: "dog" | "cat";
  readonly region?: string;
  readonly estimatedBirthDate?: Date;
  readonly availability?: "Available" | "Adopted" | "NoLongerAvailable";
  readonly bondedGroupId?: string | null;
  readonly matchableSince?: Date;
  readonly shelterId?: string;
}

/** One animal and the upload session its foreign key needs. Listed, unless told otherwise. */
async function seedAnimal(id: string, seed: AnimalSeed = {}) {
  const species = seed.species ?? "dog";
  const shelterId = seed.shelterId ?? "shelter-1";
  const at = new Date("2026-08-30").getTime();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO upload_sessions (id, shelter_id, created_at) VALUES (?, ?, ?)",
    ).bind(`session-${id}`, shelterId, at),
    // The primary photograph, which is what the digest row's thumbnail is derived from.
    env.DB.prepare(
      `INSERT INTO upload_session_photos (id, session_id, position, source_digest, original_key,
        content_type, byte_size, width, height, created_at)
       VALUES (?, ?, 0, ?, ?, 'image/jpeg', 1000, 800, 600, ?)`,
    ).bind(`photo-${id}`, `session-${id}`, `source-${id}`, `o/photo-${id}`, at),
    env.DB.prepare(
      `INSERT INTO animals (id, shelter_id, name, species, estimated_birth_date, region,
        last_confirmed_at, upload_session_id, sex, size, age_estimate_basis, good_with_children,
        good_with_dogs, good_with_cats, description, sterilisation, availability,
        matchable_since, bonded_group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Female', ?, 'VetEstimate', 'Unknown', 'Unknown',
        'Unknown', 'A good animal.', 'Unknown', ?, ?, ?)`,
    ).bind(
      id,
      shelterId,
      `Animal ${id}`,
      species,
      (seed.estimatedBirthDate ?? new Date("2023-01-01")).getTime(),
      seed.region ?? "Miranda",
      at,
      `session-${id}`,
      species === "dog" ? "Medium" : null,
      seed.availability ?? "Available",
      (seed.matchableSince ?? new Date(at)).getTime(),
      seed.bondedGroupId ?? null,
    ),
  ]);
}

/** One saved search. `{}` constrains nothing, so it matches every listed animal. */
async function seedSubscription(
  id: string,
  subscriberId: string,
  criteria: object = {},
  slot = 0,
) {
  await env.DB.prepare(
    "INSERT INTO subscriptions (id, subscriber_id, slot, criteria, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, subscriberId, slot, JSON.stringify(criteria), WEDNESDAY.getTime())
    .run();
}

/**
 * Something new for each of these subscribers to be sent: one listed animal and a search that
 * matches everything. The shard only enqueues subscribers with something to send, so the tests
 * about the shard itself need this and nothing more specific.
 */
async function withSomethingToSend(...subscriberIds: string[]) {
  await seedShelter();
  await seedAnimal("animal-1");
  for (const id of subscriberIds) await seedSubscription(`sub-${id}`, id);
}

/** One table's row count, for the "nothing was left behind" assertions. */
const countIn = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeEach(async () => {
  // Children before parents: every one of these is somebody's foreign key.
  await env.DB.exec("DELETE FROM digest_sent");
  await env.DB.exec("DELETE FROM digest_runs");
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM animals");
  await env.DB.exec("DELETE FROM upload_session_photos");
  await env.DB.exec("DELETE FROM upload_sessions");
  await env.DB.exec("DELETE FROM verifications");
  await env.DB.exec("DELETE FROM shelter_contact_points");
  await env.DB.exec("DELETE FROM shelters");
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
    await withSomethingToSend("s-wed", "s-thu");

    await runScheduled(WEDNESDAY);

    const ping = outbound.callsTo("healthchecks").at(-1)!;
    expect(JSON.parse(ping.body!)).toMatchObject({
      period: "2026-09-02",
      shard: 1,
      enqueued: 1,
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
     * ADR 0010 asks the purges to write "their counts into the `Digest Run` summary", and the
     * ping carries the same counts. A purge that silently stopped finding rows looks exactly
     * like a purge with nothing to do; these numbers are what tell them apart.
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
    await withSomethingToSend("s-wed");

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
    await withSomethingToSend("s-recent", "s-never", "s-stale");

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
    await withSomethingToSend("s-later", "s-earlier");

    const enqueued = await enqueuedBy(WEDNESDAY);

    expect(enqueued.map((m) => m.subscriberId)).toEqual([
      "s-earlier",
      "s-later",
    ]);
  });

  it("spends the whole digest budget even on a day confirmation nudges go out", async () => {
    // ADR 0009: confirmation nudges come out of the 30 held back from Resend's hundred,
    // never out of the digest's 70.
    const ids = Array.from({ length: DIGEST_DAILY_BUDGET }, (_, i) => `s-${i}`);
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          "INSERT INTO subscribers (id, email, send_day, opted_in_at, manage_token_version) VALUES (?, ?, 3, ?, 0)",
          // Opted in last week, so none is owed the ninety-day nudge, which does spend the 70.
        ).bind(id, `${id}@example.org`, WEDNESDAY.getTime() - 7 * 24 * 60 * 60_000),
      ),
    );
    await withSomethingToSend(...ids);
    // The shelter's only animal, unconfirmed for long enough to be owed a nudge.
    await env.DB.prepare("UPDATE animals SET last_confirmed_at = ?")
      .bind(new Date("2026-01-01").getTime())
      .run();

    const enqueued = await enqueuedBy(WEDNESDAY);

    expect(
      outbound.callsTo("resend").filter((call) => call.body!.includes("shelter-1@example.org")),
    ).toHaveLength(1);
    expect(enqueued).toHaveLength(DIGEST_DAILY_BUDGET);
  });
});

/** Deliver everything the run enqueued, the way the real queue would. */
async function deliverAll(enqueued: DigestMessage[]) {
  const result = await deliver(
    "pawster-digest",
    enqueued.map((body, i) => message(`m${i}`, body)),
  );
  expect(result.retryMessages).toEqual([]);
}

/**
 * The producer's half of ticket #63: for each subscriber in today's shard, the listed units
 * their searches match that they have not been sent, and nothing at all for a subscriber
 * with nothing new.
 */
describe("matching", () => {
  const NEXT_WEDNESDAY = new Date(WEDNESDAY.getTime() + 7 * 24 * 60 * 60_000);

  it("enqueues a subscriber with the listed animals their search matches", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");

    const enqueued = await enqueuedBy(WEDNESDAY);

    expect(enqueued).toEqual([
      {
        period: "2026-09-02",
        subscriberId: "s-wed",
        email: "wed@example.org",
        manageTokenVersion: 0,
        sections: [shown("sub-s-wed", [["animal-1"]])],
      },
    ]);
  });

  it("enqueues nobody whose searches match nothing", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("animal-1", { species: "cat" });
    await seedSubscription("sub-dogs", "s-wed", { species: ["dog"] });

    expect(await enqueuedBy(WEDNESDAY)).toEqual([]);
  });

  it("does not send the same animal twice once a digest carrying it was delivered", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");

    await deliverAll(await enqueuedBy(WEDNESDAY));

    expect(await enqueuedBy(NEXT_WEDNESDAY)).toEqual([]);
  });

  it("sends next week what a dropped message never delivered", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");

    // Enqueued and then lost: Queues retention, or a DLQ nobody replays. Nothing is written.
    await enqueuedBy(WEDNESDAY);

    const next = await enqueuedBy(NEXT_WEDNESDAY);
    expect(next.map((m) => m.sections)).toEqual([
      [shown("sub-s-wed", [["animal-1"]])],
    ]);
  });

  it("sends an animal whose region was corrected after a run that did not match it", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("animal-1", { region: "Carabobo" });
    await seedSubscription("sub-miranda", "s-wed", { regions: ["miranda"] });

    expect(await enqueuedBy(WEDNESDAY)).toEqual([]);

    await env.DB.prepare("UPDATE animals SET region = 'Miranda' WHERE id = 'animal-1'").run();

    const next = await enqueuedBy(NEXT_WEDNESDAY);
    expect(next.map((m) => m.sections[0]!.units)).toEqual([[["animal-1"]]]);
  });

  it("sends a puppy to a Young subscriber the week it graduates", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    // Twelve months old between the two runs.
    await seedAnimal("animal-1", { estimatedBirthDate: new Date("2025-09-05") });
    await seedSubscription("sub-young", "s-wed", { ageBands: ["Young"] });

    expect(await enqueuedBy(WEDNESDAY)).toEqual([]);
    const next = await enqueuedBy(NEXT_WEDNESDAY);
    expect(next.map((m) => m.sections[0]!.units)).toEqual([[["animal-1"]]]);
  });

  it("sends an animal whose matchable_since predates the subscriber's last digest", async () => {
    /**
     * ADR 0009 says `matchable_since` narrows candidates. No time cutoff can without dropping
     * the graduation above or the overflow below. This pins that the producer does not: the
     * sent-set alone decides what is new.
     */
    await seedSubscriber("s-wed", "wed@example.org", 3, {
      lastDigestAt: new Date("2026-08-26"),
    });
    await seedShelter();
    await seedAnimal("animal-1", { matchableSince: new Date("2026-01-01") });
    await seedSubscription("sub-all", "s-wed");

    expect((await enqueuedBy(WEDNESDAY)).map((m) => m.subscriberId)).toEqual(["s-wed"]);
  });

  it("sends a bonded group as one unit, matched as a group", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("pair-a", { bondedGroupId: "pair" });
    await seedAnimal("pair-b", { bondedGroupId: "pair" });
    await seedSubscription("sub-all", "s-wed");

    const [sent] = await enqueuedBy(WEDNESDAY);
    expect(sent!.sections).toEqual([
      shown("sub-all", [["pair-a", "pair-b"]]),
    ]);
  });

  it("sends nothing that is not listed", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("adopted", { availability: "Adopted" });
    // A shelter with no verification entry is pending, and pending is not listed.
    await env.DB.prepare(
      "INSERT INTO shelters (id, slug, display_name, account_email, base_region, country_code, created_at) VALUES ('pending', 'pending', 'Pending', 'p@example.org', 'Miranda', 'VE', 0)",
    ).run();
    await seedAnimal("unverified", { shelterId: "pending" });
    // A departed shelter's animals keep their availability but are no longer listed (#65).
    await seedShelter("departed");
    await env.DB.prepare("UPDATE shelters SET departed_at = 1 WHERE id = 'departed'").run();
    await seedAnimal("left-behind", { shelterId: "departed" });
    await seedSubscription("sub-all", "s-wed");

    expect(await enqueuedBy(WEDNESDAY)).toEqual([]);
  });

  it("sends nothing from the demo shelter, even when a real animal shares its group id", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter("demo");
    await env.DB.prepare("UPDATE shelters SET demo = 1 WHERE id = 'demo'").run();
    await seedAnimal("demo-dog", { shelterId: "demo" });
    await seedShelter();
    await seedAnimal("demo-pair", { shelterId: "demo", bondedGroupId: "pair" });
    await seedAnimal("real-pair", { bondedGroupId: "pair" });
    await seedSubscription("sub-all", "s-wed");

    expect(await enqueuedBy(WEDNESDAY)).toEqual([]);
  });

  it("gives each search its own section, and leaves out a search with nothing new", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("dog-1");
    await seedSubscription("sub-dogs", "s-wed", { species: ["dog"] }, 0);
    await seedSubscription("sub-cats", "s-wed", { species: ["cat"] }, 1);

    const [sent] = await enqueuedBy(WEDNESDAY);
    expect(sent!.sections).toEqual([
      shown("sub-dogs", [["dog-1"]]),
    ]);
  });
});

/**
 * Ticket #64's selection: what one email carries. At most 12 rows per section and 24 per
 * email, a count of what did not fit, and an animal that two searches match shown once.
 */
describe("what one email carries", () => {
  const NEXT_WEDNESDAY = new Date(WEDNESDAY.getTime() + 7 * 24 * 60 * 60_000);
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);

  it("shows at most twelve units in a section and counts the rest", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    for (const id of ids("dog", 13)) await seedAnimal(id);
    await seedSubscription("sub-all", "s-wed");

    const [sent] = await enqueuedBy(WEDNESDAY);

    expect(sent!.sections).toHaveLength(1);
    expect(sent!.sections[0]!.units).toEqual(ids("dog", 12).map((id) => [id]));
    expect(sent!.sections[0]!.more).toBe(1);
  });

  it("sends next week what did not fit this week", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    for (const id of ids("dog", 13)) await seedAnimal(id);
    await seedSubscription("sub-all", "s-wed");

    await deliverAll(await enqueuedBy(WEDNESDAY));

    const next = await enqueuedBy(NEXT_WEDNESDAY);
    expect(next.map((m) => m.sections)).toEqual([[shown("sub-all", [["dog-12"]])]]);
  });

  it("shows an animal two searches match once, and neither search sends it again", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("dog-1");
    await seedSubscription("sub-dogs", "s-wed", { species: ["dog"] }, 0);
    await seedSubscription("sub-all", "s-wed", {}, 1);

    const [sent] = await enqueuedBy(WEDNESDAY);
    expect(sent!.sections.map((section) => section.units)).toEqual([[["dog-1"]], []]);

    await deliverAll([sent!]);
    expect(await enqueuedBy(NEXT_WEDNESDAY)).toEqual([]);
  });
});

/**
 * Ticket #64's email, read structurally from the payload Resend was handed. No whole-HTML
 * snapshot on purpose: it would churn on every wording change and would not have caught the
 * mid-word truncation that rendering at 390px found.
 */
describe("the email", () => {
  /** Run the producer on Wednesday, deliver what it enqueued, and return the HTML sent. */
  async function emailOn(scheduledTime = WEDNESDAY): Promise<string> {
    await deliverAll(await enqueuedBy(scheduledTime));
    const sends = digests();
    expect(sends).toHaveLength(1);
    return JSON.parse(sends[0]!.body!).html;
  }
  const count = (html: string, needle: string) => html.split(needle).length - 1;
  // The digest's sends, without the ninety-day nudge a subscriber opted in at epoch is owed.
  const digests = () =>
    outbound.callsTo("resend").filter((call) => call.headers["idempotency-key"]);

  it("gives each row a thumbnail, a name, one meta line and one provenance line, and no description", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("dog-1");
    await seedSubscription("sub-all", "s-wed");

    const html = await emailOn();

    expect(count(html, 'class="row"')).toBe(1);
    // The 144x144 JPEG derivative, drawn at 72: the key the upload pipeline wrote, not WebP.
    const key = await derivativeKey("source-dog-1", "digestThumbnail");
    expect(key.endsWith(".jpg")).toBe(true);
    expect(html).toContain(`src="${env.MEDIA_BASE_URL}/${key}"`);
    expect(html).toMatch(/<img[^>]*width="72"[^>]*height="72"/);
    expect(html).toContain("Animal dog-1");
    expect(html).toContain("Perra adulta · Mediana");
    expect(html).toContain("Miranda · Confirmada hace 3 días");
    expect(html).not.toContain("A good animal.");
    expect(html).toContain(`${env.SITE_ORIGIN}/a/dog-1/`);
  });

  it("shows a bonded group as one row, named together", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("pair-a", { bondedGroupId: "pair" });
    await seedAnimal("pair-b", { bondedGroupId: "pair" });
    await seedSubscription("sub-all", "s-wed");

    const html = await emailOn();

    expect(count(html, 'class="row"')).toBe(1);
    expect(html).toContain("Animal pair-a y Animal pair-b");
  });

  it("heads each search's section with its criteria as chips", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    await seedAnimal("dog-1");
    await seedAnimal("cat-1", { species: "cat" });
    await seedSubscription("sub-dogs", "s-wed", { species: ["dog"] }, 0);
    await seedSubscription("sub-cats", "s-wed", { species: ["cat"], regions: ["Miranda"] }, 1);

    const html = await emailOn();

    expect(count(html, 'class="section"')).toBe(2);
    const [, dogs, cats] = html.split('class="section"');
    expect(chips(dogs!)).toEqual(["Perros"]);
    // Stored criteria are normalised (`normaliseRegion`), and web shows them as stored.
    expect(chips(cats!)).toEqual(["Gatos", "miranda"]);
  });

  it('says "and N more" exactly when a section was cut', async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter();
    for (let i = 10; i < 23; i++) await seedAnimal(`dog-${i}`);
    await seedAnimal("cat-1", { species: "cat" });
    await seedSubscription("sub-dogs", "s-wed", { species: ["dog"] }, 0);
    await seedSubscription("sub-cats", "s-wed", { species: ["cat"] }, 1);

    const html = await emailOn();

    expect(count(html, 'class="row"')).toBe(13);
    expect(count(html, "más")).toBe(1);
    expect(html).toContain("y 1 coincidencia más");
  });

  it("is fluid: full width up to 600px, fixed table layout, and nothing wider than a phone", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");

    const html = await emailOn();

    expect(html).toContain("width:100%;max-width:600px");
    expect(html).toContain("table-layout:fixed");
    expect(html).toContain("overflow-wrap:anywhere");
    // The fixed-600-plus-media-query pattern is what truncated mid-word at 390px.
    const fixed = [...html.matchAll(/(?<!max-)width:\s*(\d+)px|width="(\d+)"/g)].map((m) =>
      Number(m[1] ?? m[2]),
    );
    expect(fixed.every((px) => px <= 390)).toBe(true);
    expect(html).not.toContain("@media");
  });

  it("says that silence means nothing new, and carries the manage and unsubscribe links", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3, { manageTokenVersion: 2 });
    await withSomethingToSend("s-wed");

    const html = await emailOn();

    expect(html).toContain("Si no llega nada, es que no hubo.");
    const manage = html.match(new RegExp(`href="(${env.SITE_ORIGIN}${MANAGE_PATH}/[^"]+)"`));
    await expect(
      verifyManageToken(env, manage![1]!.slice(`${env.SITE_ORIGIN}${MANAGE_PATH}/`.length)),
    ).resolves.toEqual({ subscriberId: "s-wed", version: 2 });
    expect(html).toContain(`href="${env.SITE_ORIGIN}${UNSUBSCRIBE_PATH}/`);
  });

  it("sends the same email under the same key when a message is redelivered, and remembers nothing more", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");
    const enqueued = await enqueuedBy(WEDNESDAY);

    await deliverAll(enqueued);
    const sentRows = await countIn("digest_sent");
    await deliverAll(enqueued);

    const [first, second] = digests();
    expect(second!.headers["idempotency-key"]).toBe(first!.headers["idempotency-key"]);
    // Resend answers a reused key with a different body with 409, which would retry the
    // message into the dead-letter queue. So a redelivery must render byte for byte the same.
    expect(second!.body).toBe(first!.body);
    expect(await countIn("digest_sent")).toBe(sentRows);
    expect(outbound.callsTo("resend").some((call) => call.url.includes("/batch"))).toBe(false);
  });

  it("treats a 409 on a reused key as already sent, and remembers what it carried", async () => {
    // The send went out, the write after it failed, and the animal changed before the retry:
    // the retry renders different bytes under the same key and Resend answers 409.
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");
    const enqueued = await enqueuedBy(WEDNESDAY);
    outbound.on(
      "resend",
      () =>
        new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }),
    );

    await deliverAll(enqueued);

    expect(await countIn("digest_sent")).toBe(1);
  });

  it("leaves out an animal delisted between the run and the send, and remembers only the rest", async () => {
    // #65: delisting is immediate, and a queued email is no exception.
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await seedShelter("staying");
    await seedShelter("leaving");
    await seedAnimal("kept", { shelterId: "staying" });
    await seedAnimal("gone", { shelterId: "leaving" });
    await seedSubscription("sub-all", "s-wed");
    const enqueued = await enqueuedBy(WEDNESDAY);
    await env.DB.prepare("UPDATE shelters SET departed_at = ? WHERE id = 'leaving'")
      .bind(WEDNESDAY.getTime())
      .run();

    const html = await (async () => {
      await deliverAll(enqueued);
      return JSON.parse(digests()[0]!.body!).html as string;
    })();

    expect(html).toContain("Animal kept");
    expect(html).not.toContain("Animal gone");
    const remembered = await env.DB.prepare("SELECT animal_id FROM digest_sent").all();
    expect(remembered.results).toEqual([{ animal_id: "kept" }]);
  });

  it("sends nothing when everything it was going to show has been delisted", async () => {
    await seedSubscriber("s-wed", "wed@example.org", 3);
    await withSomethingToSend("s-wed");
    const enqueued = await enqueuedBy(WEDNESDAY);
    await env.DB.prepare("UPDATE animals SET availability = 'Adopted'").run();

    await deliverAll(enqueued);

    expect(digests()).toEqual([]);
    expect(await countIn("digest_sent")).toBe(0);
  });
});

/** The chip texts in one section's header, in order. */
function chips(section: string): string[] {
  return [...section.matchAll(/class="chip"[^>]*>([^<]*)</g)].map((m) => m[1]!);
}

/**
 * The Digest Run record (`CONTEXT.md`): one row per run, counts only, kept after every purge.
 */
describe("the run record", () => {
  it("records one row per run with the same counts the watchdog is sent", async () => {
    // Opted in recently, so neither is owed the ninety-day nudge.
    const optedInAt = new Date("2026-08-30");
    await seedSubscriber("s-wed", "wed@example.org", 3, { optedInAt });
    await seedSubscriber("s-idle", "idle@example.org", 3, { optedInAt });
    await seedShelter();
    await seedAnimal("animal-1");
    await seedSubscription("sub-wed", "s-wed");

    await runScheduled(WEDNESDAY);

    const { results } = await env.DB.prepare(
      "SELECT period, shard, enqueued, units, nudged, purged_opt_ins, purged_opt_in_mails, erased_subscribers FROM digest_runs",
    ).all();
    expect(results).toEqual([
      {
        period: "2026-09-02",
        shard: 2,
        enqueued: 1,
        units: 1,
        nudged: 0,
        purged_opt_ins: 0,
        purged_opt_in_mails: 0,
        erased_subscribers: 0,
      },
    ]);
    expect(JSON.parse(outbound.callsTo("healthchecks")[0]!.body!)).toMatchObject({
      shard: 2,
      enqueued: 1,
      units: 1,
    });
  });

  it("survives the purges of later runs", async () => {
    const DAY = 24 * 60 * 60_000;
    await runScheduled(WEDNESDAY);
    await runScheduled(new Date(WEDNESDAY.getTime() + 400 * DAY));

    expect(await countIn("digest_runs")).toBe(2);
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
    expect(link.startsWith(`${env.SITE_ORIGIN}${UNSUBSCRIBE_PATH}/`)).toBe(true);

    const token = link.slice(`${env.SITE_ORIGIN}${UNSUBSCRIBE_PATH}/`.length);
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

/**
 * ADR 0010's ninety-day grace period, from both ends. Unsubscribing is not erasure — "erasing
 * on the spot would turn every one of those [prefetcher clicks] into the permanent loss of
 * three saved searches" — and the automatic expiry "is what stops the grace period from
 * quietly becoming indefinite retention".
 *
 * Both halves are asserted here rather than only against the query, for the reason the purge
 * preamble above is: what makes the retention real is that *this handler* runs it.
 */
describe("the unsubscribe grace period", () => {
  const DAY = 24 * 60 * 60_000;

  it("erases a subscriber ninety days after they unsubscribed, and their searches with them", async () => {
    await seedSubscriber("s-old", "old@example.org", 3, {
      unsubscribedAt: new Date(WEDNESDAY.getTime() - 91 * DAY),
    });
    await seedSubscription("sub-old", "s-old");

    await runScheduled(WEDNESDAY);

    expect(await countIn("subscribers")).toBe(0);
    // Children before the parent: a subscription left behind would be an orphan row naming
    // somebody the platform promised to forget.
    expect(await countIn("subscriptions")).toBe(0);
  });

  it("leaves an unsubscribed subscriber alone inside the grace period", async () => {
    await seedSubscriber("s-recent", "recent@example.org", 3, {
      unsubscribedAt: new Date(WEDNESDAY.getTime() - 89 * DAY),
    });

    await runScheduled(WEDNESDAY);

    // The whole point of the ninety days: a mis-tap or a prefetcher is still undoable.
    expect(await countIn("subscribers")).toBe(1);
  });

  it("takes an unredeemed opt-in for the same address with it", async () => {
    await seedSubscriber("s-old", "old@example.org", 3, {
      unsubscribedAt: new Date(WEDNESDAY.getTime() - 91 * DAY),
    });
    await env.DB.prepare(
      "INSERT INTO pending_opt_ins (token_hash, email, criteria, locale, ip_hash, created_at) VALUES (?, ?, '{}', 'es', 'ip', ?)",
    )
      .bind("live-link", "old@example.org", WEDNESDAY.getTime())
      .run();

    await runScheduled(WEDNESDAY);

    // Otherwise a link sent days before the erasure would recreate the subscriber afterwards.
    expect(await countIn("pending_opt_ins")).toBe(0);
  });

  it("never enqueues a subscriber who has unsubscribed or been retired", async () => {
    await seedSubscriber("s-live", "live@example.org", 3);
    await seedSubscriber("s-gone", "gone@example.org", 3, {
      unsubscribedAt: new Date(WEDNESDAY.getTime() - DAY),
    });
    await seedSubscriber("s-bounced", "bounced@example.org", 3, {
      retiredAt: new Date(WEDNESDAY.getTime() - DAY),
      retirementReason: "bounce",
    });
    await withSomethingToSend("s-live", "s-gone", "s-bounced");

    const enqueued = await enqueuedBy(WEDNESDAY);

    // Without this clause, "we keep your searches for ninety days" would mean "we keep
    // mailing you for ninety days".
    expect(enqueued.map((m) => m.subscriberId)).toEqual(["s-live"]);
  });

  it("reports what it erased to the watchdog", async () => {
    await seedSubscriber("s-old", "old@example.org", 3, {
      unsubscribedAt: new Date(WEDNESDAY.getTime() - 91 * DAY),
    });

    await runScheduled(WEDNESDAY);

    expect(JSON.parse(outbound.callsTo("healthchecks")[0]!.body!)).toMatchObject({
      erasedSubscribers: 1,
    });
  });
});

/**
 * The ninety-day "still nothing" nudge. ADR 0010 wants it because "a subscriber who never
 * matches anything receives no digest and therefore no footer", and the manage page is the
 * subject-access response — so without this mail there is a subscriber whose data we act on
 * and who holds no route back to it.
 */
describe("the never-matched nudge", () => {
  const DAY = 24 * 60 * 60_000;
  const LONG_AGO = new Date(WEDNESDAY.getTime() - 91 * DAY);

  const nudges = () =>
    outbound
      .callsTo("resend")
      .map((call) => JSON.parse(call.body!))
      .filter((mail) => /todav[ií]a no/i.test(String(mail.subject)));

  it("sends one, carrying a manage link that actually verifies", async () => {
    await seedSubscriber("s-quiet", "quiet@example.org", 3, {
      optedInAt: LONG_AGO,
    });

    await runScheduled(WEDNESDAY);

    const [mail] = nudges();
    expect(mail.to).toEqual(["quiet@example.org"]);

    const link = String(mail.text).match(
      new RegExp(`${env.SITE_ORIGIN}${MANAGE_PATH}/\\S+`),
    );
    expect(link, "the nudge should carry a manage link").not.toBeNull();

    const token = link![0].slice(`${env.SITE_ORIGIN}${MANAGE_PATH}/`.length);
    await expect(verifyManageToken(env, token)).resolves.toEqual({
      subscriberId: "s-quiet",
      version: 0,
    });
  });

  it("sends it once, because the row and not the period is what stops it", async () => {
    await seedSubscriber("s-quiet", "quiet@example.org", 3, {
      optedInAt: LONG_AGO,
    });

    await runScheduled(WEDNESDAY);
    outbound.reset();
    await runScheduled(WEDNESDAY);

    // A cutoff on its own would nudge the same silent subscriber every day the cron ran.
    expect(nudges()).toHaveLength(0);
  });

  it("does not nudge a subscriber who has received a digest", async () => {
    await seedSubscriber("s-served", "served@example.org", 3, {
      optedInAt: LONG_AGO,
      lastDigestAt: new Date(WEDNESDAY.getTime() - DAY),
    });

    await runScheduled(WEDNESDAY);

    expect(nudges()).toHaveLength(0);
  });

  it("does not nudge a subscriber who has unsubscribed", async () => {
    await seedSubscriber("s-gone", "gone@example.org", 3, {
      optedInAt: LONG_AGO,
      unsubscribedAt: new Date(WEDNESDAY.getTime() - DAY),
    });

    await runScheduled(WEDNESDAY);

    // The sharpest version of the mistake this clause prevents: mailing somebody who asked
    // us to stop, using the mechanism that exists to hand them a working link.
    expect(nudges()).toHaveLength(0);
  });

  it("does not nudge before the ninety days are up", async () => {
    await seedSubscriber("s-new", "new@example.org", 3, {
      optedInAt: new Date(WEDNESDAY.getTime() - 89 * DAY),
    });

    await runScheduled(WEDNESDAY);

    expect(nudges()).toHaveLength(0);
  });

  it("leaves nudged_at unwritten when the send failed, so the next run retries", async () => {
    await seedSubscriber("s-quiet", "quiet@example.org", 3, {
      optedInAt: LONG_AGO,
    });
    outbound.on("resend", () => new Response("rate limited", { status: 429 }));

    await runScheduled(WEDNESDAY);

    const [row] = await createDb(env.DB)
      .select({ nudgedAt: subscribers.nudgedAt })
      .from(subscribers)
      .where(eq(subscribers.id, "s-quiet"));
    // A nudge marked sent but never delivered is a subscriber left with no working link,
    // which is the outcome the whole mechanism exists to prevent.
    expect(row!.nudgedAt).toBeNull();
  });

  it("does not let one refused address take the day's digests down with it", async () => {
    await seedSubscriber("s-quiet", "quiet@example.org", 3, { optedInAt: LONG_AGO });
    await seedSubscriber("s-live", "live@example.org", 3, {
      lastDigestAt: new Date(WEDNESDAY.getTime() - DAY),
    });
    await withSomethingToSend("s-live");
    outbound.on("resend", () => new Response("nope", { status: 500 }));

    const enqueued = await enqueuedBy(WEDNESDAY);

    expect(enqueued.map((m) => m.subscriberId)).toContain("s-live");
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
