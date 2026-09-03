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
import { digestIdempotencyKey } from "@pawster/domain";
import { beforeEach, describe, expect, it } from "vitest";
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

async function seedSubscriber(id: string, email: string, sendDay: number) {
  await createDb(env.DB)
    .insert(subscribers)
    .values({ id, email, sendDay, optedInAt: new Date(0) });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM subscribers");
});

describe("scheduled()", () => {
  it("runs the handler and the watchdog ping is visible in the interceptor's call log", async () => {
    await runScheduled(WEDNESDAY);

    const pings = outbound.callsTo("healthchecks");
    expect(pings).toHaveLength(1);
    expect(pings[0]!.url).toBe(`${env.HEALTHCHECK_URL}/start`);
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

    // Two invocations of the same isolate. A client cached across them would throw
    // "Cannot perform I/O on behalf of a different request" on this second call — the
    // failure `db/test/module-scope-is-wrong.test.ts` demonstrates deliberately.
    await runScheduled(WEDNESDAY);
    await runScheduled(WEDNESDAY);

    expect(outbound.callsTo("healthchecks")).toHaveLength(2);
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
