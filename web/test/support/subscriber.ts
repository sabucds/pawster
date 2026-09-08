/**
 * Getting a subscriber from a form post to a live subscription, through the Worker's own
 * front door.
 *
 * Every request goes through `SELF.fetch()` against a real local D1 with the real migrations
 * applied, and the opt-in link is read out of the single outbound interceptor rather than
 * constructed here. That last part is the point: a helper that minted its own token would be
 * asserting against a link the platform never sent, and "exactly one opt-in email per signup"
 * (the ticket's ninth criterion) would have nothing to count.
 */

import { createDb } from "@pawster/db";
import { env } from "cloudflare:test";
import { expect } from "vitest";
import { outbound } from "../../../test/outbound.ts";
import {
  doNotContactCanary,
  doNotContactDigest,
} from "../../src/lib/subscriber/crypto.ts";
import {
  assertPepperUnchanged,
  refuseContact,
} from "../../src/lib/subscriber/store.ts";
import { post } from "./http.ts";

export const SUBSCRIBER_EMAIL = "ana@adoptante.example";

/**
 * The form as a browser would submit it: an address, two axes ticked, and a locale.
 *
 * Deliberately not the empty criteria, so that the default path through every test exercises
 * the parser and the canonical JSON rather than the "send me everything" shortcut. The empty
 * case has a test of its own.
 */
export const SIGNUP = {
  email: SUBSCRIBER_EMAIL,
  species: ["dog"],
  sizes: ["Small", "Medium"],
  regions: "Miranda",
  locale: "es",
};

export async function signUp(
  overrides: Record<string, string | readonly string[]> = {},
  options: Parameters<typeof post>[2] = {},
): Promise<Response> {
  return await post("/api/resumen/suscribir", { ...SIGNUP, ...overrides }, options);
}

/**
 * The opt-in token Pawster just emailed, read out of the interceptor's call log.
 *
 * Asserts there is exactly one call, which is how the ninth acceptance criterion is enforced
 * at every call site rather than in one test: a change that mailed twice would fail wherever
 * this is used, not only where it is checked on purpose.
 */
export function emailedToken(): string {
  const calls = outbound.callsTo("resend");
  expect(calls, "one signup should send exactly one email").toHaveLength(1);
  const body = JSON.parse(calls[0]!.body!) as { text: string };
  const match = body.text.match(/\/resumen\/activar\?t=([\w%-]+)/);
  expect(match, "the opt-in email should carry an activation link").not.toBeNull();
  return decodeURIComponent(match![1]!);
}

/** Where the email says to go, in full, for the tests that follow it as a browser would. */
export function emailedUrl(): string {
  const calls = outbound.callsTo("resend");
  const body = JSON.parse(calls[0]!.body!) as { text: string };
  return body.text.match(/https?:\/\/\S+/)![0]!;
}

/** Follow the link's `POST`, which is the act that opts in. */
export function activate(
  token: string,
  options: Parameters<typeof post>[2] = {},
): Promise<Response> {
  return post("/resumen/activar", { t: token }, options);
}

/**
 * Sign up and follow the link, coming back with the send day the platform assigned.
 *
 * The interceptor is reset in between so the next signup's `emailedToken()` still sees
 * exactly one call — the suite-wide `beforeEach` only resets between tests, and several tests
 * here opt three or eight people in inside one.
 */
export async function subscribe(
  overrides: Record<string, string | readonly string[]> = {},
): Promise<number> {
  outbound.reset();
  await signUp(overrides);
  const response = await activate(emailedToken());
  expect(response.status).toBe(303);

  const location = response.headers.get("location") ?? "";
  const day = Number(new URL(location, "https://pawster.test").searchParams.get("dia"));
  expect(
    Number.isInteger(day),
    `activating should land on the success page with a send day, got ${location}`,
  ).toBe(true);
  return day;
}

/**
 * Move every subscriber clock further into the past.
 *
 * The alternative would be faking a clock, and there is nothing to fake: the endpoints read
 * `new Date()` and compare it against the stored columns, so shifting the rows is the same
 * arithmetic from the other side and it exercises the real query. A test that needs an
 * address to sign up twice is describing somebody who signed up yesterday, which is what this
 * makes true.
 */
export async function ageOptInClocks(ms: number): Promise<void> {
  await env.DB.prepare("UPDATE opt_in_mails SET sent_at = sent_at - ?").bind(ms).run();
  await env.DB.prepare("UPDATE pending_opt_ins SET created_at = created_at - ?")
    .bind(ms)
    .run();
}

/**
 * Put an address on the Do-Not-Contact list, canary first.
 *
 * The order is the platform's own and not a convenience: the canary is written by the first
 * signup the platform ever serves, and a Retirement can only happen to somebody who
 * subscribed after that. So a list holding an entry with no canary beside it is a state that
 * cannot arise forwards — it is what a *deleted* canary looks like, which
 * `assertPepperUnchanged` refuses to serve a signup from. A helper that skipped the canary
 * would be setting up that failure and calling it a Do-Not-Contact test.
 */
export async function refuseAddress(email: string): Promise<void> {
  const db = createDb(env.DB);
  const now = new Date();
  await assertPepperUnchanged(db, await doNotContactCanary(env), now);
  await refuseContact(db, await doNotContactDigest(env, email), now);
}

/** One table's rows, for the counting and the "nothing was written" assertions. */
export async function rowsIn(table: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ${table} ORDER BY rowid`,
  ).all();
  return results as Record<string, unknown>[];
}

export async function countIn(table: string): Promise<number> {
  return (await rowsIn(table)).length;
}

/** Every table a subscriber's rows reach, children before parents. */
export async function clearSubscriberTables(): Promise<void> {
  await env.DB.exec("DELETE FROM subscriptions");
  await env.DB.exec("DELETE FROM subscribers");
  await env.DB.exec("DELETE FROM pending_opt_ins");
  await env.DB.exec("DELETE FROM opt_in_mails");
  await env.DB.exec("DELETE FROM do_not_contact");
}
