import { createDb, shelters } from "@pawster/db";
import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { outbound } from "../../../test/outbound.ts";

/**
 * Getting a shelter registered and signed in, through the Worker's own front door.
 *
 * Extracted because two suites need it and neither owns it: `shelter-access.test.ts` tests
 * the sign-in flow itself, and `shelter-profile.test.ts` needs a session before it can test
 * anything at all. A second copy would be worse than an import — the flow spans a
 * registration post, a code request, an emailed code read out of the outbound interceptor
 * and two cookies, and a copy of it would silently stop matching the real one the first time
 * ADR 0013's mechanics move.
 *
 * Every request goes through `SELF.fetch()` — the whole Worker, asset router included —
 * against a real local D1 with the real migrations applied, and every email leaves through
 * the single outbound interceptor.
 */

export const ORIGIN = "https://pawster.test";

/** A distinct IP per call, so the per-IP request limit cannot leak between tests. */
let ip = 0;
const nextIp = () => `203.0.113.${++ip % 250}`;

export interface PostOptions {
  cookie?: string;
  ip?: string;
  /** Overridden only by the test that checks a cross-site post is refused. */
  origin?: string;
}

/**
 * `redirect: "manual"` throughout, because the redirect *is* the response under test: which
 * page a code request sends you to is the whole of ADR 0008's identical-response rule, and
 * whether a profile save answers 303 or 200 is how a refusal is told from a success.
 */
export function post(
  path: string,
  fields: Record<string, string | readonly string[]>,
  options: PostOptions = {},
): Promise<Response> {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value as string]) {
      body.append(name, item);
    }
  }
  /**
   * `Origin` is sent because a browser sends it on a form post, and Astro's built-in
   * `security.checkOrigin` refuses a same-site form submission without it with a 403. That
   * check is a CSRF defence worth keeping on these endpoints, so the tests match what a
   * browser does rather than turning it off.
   */
  const headers = new Headers({
    "cf-connecting-ip": options.ip ?? nextIp(),
    origin: options.origin ?? ORIGIN,
  });
  if (options.cookie) headers.set("cookie", options.cookie);

  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    body,
    headers,
    redirect: "manual",
  });
}

export function get(path: string, cookie?: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    headers: cookie ? { cookie } : undefined,
    redirect: "manual",
  });
}

/** One `Set-Cookie` off a response, reduced to its `name=value` for sending back. */
export function cookieFrom(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

export const REGISTRATION = {
  displayName: "Refugio Los Teques",
  accountEmail: "hola@refugio.example",
  baseRegion: "Miranda",
  countryCode: "VE",
  contactKind: ["whatsapp", "instagram", "email"],
  contactValue: ["+58 412 5550001", "", ""],
};

export async function register(
  overrides: Record<string, string | readonly string[]> = {},
) {
  return await post("/refugios/registro", { ...REGISTRATION, ...overrides });
}

/** The code Pawster just emailed, read out of the interceptor's call log. */
export function emailedCode(): string {
  const calls = outbound.callsTo("resend");
  expect(calls).toHaveLength(1);
  const body = JSON.parse(calls[0]!.body!) as { text: string };
  const match = body.text.match(/\b(\d{6})\b/);
  expect(match, "the code email should carry six digits").not.toBeNull();
  return match![1]!;
}

/** Ask for a code and come back with the handle and the digits. */
export async function requestCode(accountEmail: string, options: PostOptions = {}) {
  const response = await post("/api/refugios/codigo", { accountEmail }, options);
  return {
    response,
    token: cookieFrom(response, "pawster_sign_in"),
    code: emailedCode(),
  };
}

export interface SignedIn {
  readonly shelterId: string;
  readonly cookie: string;
}

/** Register, request a code, type it, and come back holding a session cookie. */
export async function signIn(
  accountEmail: string = REGISTRATION.accountEmail,
): Promise<SignedIn> {
  await register({ accountEmail });
  const { token, code } = await requestCode(accountEmail);

  const response = await post("/api/refugios/sesion", { code }, { cookie: token! });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/refugios/panel");

  const cookie = cookieFrom(response, "pawster_session");
  expect(cookie).not.toBeNull();

  const db = createDb(env.DB);
  const [row] = await db
    .select({ id: shelters.id })
    .from(shelters)
    .where(eq(shelters.accountEmail, accountEmail));

  return { shelterId: row!.id, cookie: cookie! };
}

/**
 * Move every ledger row further into the past, so the next request is outside the
 * five-minute per-address cooldown.
 *
 * The alternative would be faking a clock, and there is nothing to fake: the endpoints read
 * `new Date()` and compare it against `sign_in_requests.requested_at`, so shifting the rows
 * is the same arithmetic from the other side and it exercises the real query. A test that
 * needs a shelter to hold two codes in succession is describing a shelter that asked for one
 * ten minutes ago, which is what this makes true.
 */
export async function ageMailLedger(ms: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE sign_in_requests SET requested_at = requested_at - ?",
  )
    .bind(ms)
    .run();
}

/** Every table a shelter's rows reach, children before parents. */
export async function clearShelterTables(): Promise<void> {
  await env.DB.exec("DELETE FROM animals");
  await env.DB.exec("DELETE FROM one_time_codes");
  await env.DB.exec("DELETE FROM sign_in_requests");
  await env.DB.exec("DELETE FROM shelter_contact_points");
  await env.DB.exec("DELETE FROM shelters");
}
