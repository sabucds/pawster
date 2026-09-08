import { env, SELF } from "cloudflare:test";
import { createDb, oneTimeCodes, shelters } from "@pawster/db";
import { isListed } from "@pawster/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { hashOneTimeCode } from "../src/lib/auth/crypto.ts";
import {
  ONE_TIME_CODE_MAX_ATTEMPTS,
  ONE_TIME_CODE_TTL_MS,
  SESSION_REFRESH_AFTER_MS,
  SIGN_IN_GLOBAL_DAILY_CEILING,
} from "../src/lib/auth/policy.ts";
import { encodeSession } from "../src/lib/auth/session.ts";
import { readShelterFacts } from "../src/lib/auth/store.ts";
import {
  ORIGIN,
  cookieFrom,
  get,
  post,
} from "./support/http.ts";
import {
  REGISTRATION,
  ageMailLedger,
  clearShelterTables,
  register,
  requestCode,
  signIn,
} from "./support/shelter.ts";

/**
 * Registration and emailed-code sign-in, through the Worker's own front door.
 *
 * Every request here goes through `SELF.fetch()` — the whole Worker, asset router included —
 * against a real local D1 with the real migrations applied, and every email leaves through
 * the single outbound interceptor. So "exactly one email per code request" is an assertion
 * against one ordered call log rather than a question asked of a mock.
 *
 * The machinery for getting a shelter registered and signed in lives in `support/shelter.ts`,
 * because `shelter-profile.test.ts` needs a session before it can test anything and a second
 * copy of this flow would stop matching the real one the first time ADR 0013's mechanics
 * move. What stays here is what only this suite asks: {@link snapshot}, which is the
 * "no write happened" assertion.
 */

/** Every row the platform holds, for the "no write happened" assertion. */
async function snapshot(): Promise<string> {
  const tables = [
    "shelters",
    "shelter_contact_points",
    "one_time_codes",
    "sign_in_requests",
    "animals",
    "subscribers",
  ];
  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM ${table} ORDER BY rowid`,
    ).all();
    dump[table] = results;
  }
  return JSON.stringify(dump);
}

beforeEach(clearShelterTables);

describe("registration", () => {
  it("writes a shelter with a slug derived from the display name", async () => {
    const response = await register();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/registro/listo");

    const db = createDb(env.DB);
    const [shelter] = await db.select().from(shelters);

    expect(shelter).toMatchObject({
      slug: "refugio-los-teques",
      displayName: "Refugio Los Teques",
      accountEmail: "hola@refugio.example",
      baseRegion: "Miranda",
      countryCode: "VE",
      sessionEpoch: 0,
    });
  });

  it("writes no verification row, because pending is the absence of one", async () => {
    /**
     * ADR 0003 makes standing an append-only log whose latest entry is the current
     * standing, so "awaiting verification" is the absence of any entry — there is no pending
     * state to set. Asserted two ways: registration touches only the two tables it should,
     * and no table on the platform holds verification entries for it to have written to.
     */
    await register();

    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const tables = results.map((row) => row.name);

    expect(tables).not.toContain("verifications");
    expect(tables.filter((name) => name.includes("verif"))).toEqual([]);

    const counted = async (table: string) => {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
        n: number;
      }>();
      return row!.n;
    };
    expect(await counted("shelters")).toBe(1);
    expect(await counted("shelter_contact_points")).toBe(1);
    // Registration sends no mail, so it spends none of the sign-in allocation either.
    expect(await counted("sign_in_requests")).toBe(0);
    expect(outbound.calls).toHaveLength(0);
  });

  it("keeps the first shelter's slug when a second registers under the same name", async () => {
    /**
     * The immutability the column's comment promises, from the only angle a test can reach
     * it: the slug already handed out is not revisited when a collision arrives. The newcomer
     * is numbered instead.
     */
    await register();
    await register({ accountEmail: "otro@refugio.example" });

    const db = createDb(env.DB);
    const rows = await db
      .select({ slug: shelters.slug, email: shelters.accountEmail })
      .from(shelters);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.email === "hola@refugio.example")?.slug).toBe(
      "refugio-los-teques",
    );
    expect(rows.find((row) => row.email === "otro@refugio.example")?.slug).toBe(
      "refugio-los-teques-2",
    );
  });

  it("refuses a registration with no contact point, and says why", async () => {
    /**
     * Not paperwork: `isListed()` requires `contactPointCount > 0`, so a shelter with none
     * would publish animals nobody can see — and nothing on its own screen would look wrong.
     * The refusal has to explain that, or it reads as an arbitrary required field.
     */
    const response = await register({ contactValue: ["", "", ""] });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-testid="errors"');
    expect(html).toContain("no le aparecerían a nadie");

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM shelters").first<{
      n: number;
    }>();
    expect(row!.n).toBe(0);
  });

  it("reports every bad field at once and keeps what was typed", async () => {
    const response = await register({
      displayName: "",
      accountEmail: "not-an-email",
      baseRegion: "Zulia",
    });
    const html = await response.text();

    expect(html).toContain("Escribe el nombre del refugio.");
    expect(html).toContain("Ese correo no parece completo.");
    // The value survives the refusal, so a shelter with one typo does not retype the form.
    expect(html).toContain('value="Zulia"');
  });

  it("answers an already-registered address exactly as it answers a new one", async () => {
    /**
     * A registration form that said "that address is taken" would be the same
     * shelter-enumeration oracle ADR 0008 forbids the code-request form from being — the
     * question would just have moved to a different page. So the two responses are identical
     * and no second shelter is written.
     */
    const first = await register();
    const second = await register({ displayName: "Otro Nombre Entero" });

    expect(second.status).toBe(first.status);
    expect(second.headers.get("location")).toBe(first.headers.get("location"));

    const db = createDb(env.DB);
    const rows = await db.select({ slug: shelters.slug }).from(shelters);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("refugio-los-teques");
  });
});

describe("the post-registration page", () => {
  it("promises three days, invites chasing, and says nothing is visible yet", async () => {
    // Prerendered, so it is asked of the asset store directly — the same assertion
    // `routing.test.ts` makes about `/`, and what proves it costs no Worker invocation.
    const asset = await env.ASSETS.fetch(`${ORIGIN}/refugios/registro/listo`);
    const html = await asset.text();

    expect(asset.status).toBe(200);
    expect(html).toContain("tres días");
    expect(html).toContain("escríbenos");
    expect(html).toContain("no estás molestando");
    expect(html).toContain("Todavía no se ve nada de lo tuyo");
    expect(html).toContain("Ya puedes entrar y publicar");
  });
});

describe("requesting a code", () => {
  it("sends exactly one email, carrying six digits and no link", async () => {
    await register();
    const { response } = await requestCode(REGISTRATION.accountEmail);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/entrar/codigo");

    const calls = outbound.callsTo("resend");
    expect(calls).toHaveLength(1);
    expect(outbound.calls).toHaveLength(1);

    const body = JSON.parse(calls[0]!.body!) as {
      to: string[];
      subject: string;
      text: string;
    };
    expect(body.to).toEqual([REGISTRATION.accountEmail]);
    expect(body.subject).toMatch(/\d{6}/);
    /**
     * No URL with a path in it, anywhere. ADR 0013 chose a code over a link because a mail
     * scanner fetches URLs with no human behind them, and a "click here" convenience link
     * would have reintroduced exactly that. The bare origin is allowed — it is something to
     * type, not something to fetch.
     */
    expect(body.text).not.toMatch(/https?:\/\/\S+\/\S/);

    /**
     * And no idempotency key, which is the opposite of the digest's choice in
     * `digest/src/resend.ts`. Every code request mints a *new* code and retires the last, so
     * two requests must produce two emails; a key would have swallowed the second and left a
     * shelter holding a code the database had already superseded.
     */
    expect(Object.keys(calls[0]!.headers)).not.toContain("idempotency-key");
  });

  it("answers an unregistered address the same way as a registered one", async () => {
    /**
     * The enumeration assertion. `pawster_sign_in` holds a random 32-byte token in both
     * cases, so the responses cannot be *byte*-identical in the literal sense — but the token
     * is equally random for a registered address, which is the property that matters: nothing
     * that varies between the two branches carries any signal.
     *
     * So this asserts the strong form. Everything except that token is identical, and the
     * token is the same length and shape either way.
     */
    await register();

    const known = await post("/api/refugios/codigo", {
      accountEmail: REGISTRATION.accountEmail,
    });
    outbound.reset();
    const unknown = await post("/api/refugios/codigo", {
      accountEmail: "nobody@example.org",
    });

    expect(unknown.status).toBe(known.status);
    expect(unknown.headers.get("location")).toBe(known.headers.get("location"));
    expect(await unknown.text()).toBe(await known.text());

    const strip = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((header) => header.replace(/pawster_sign_in=[^;]+/, "pawster_sign_in=<token>"));
    expect(strip(unknown)).toEqual(strip(known));

    const tokenOf = (response: Response) =>
      cookieFrom(response, "pawster_sign_in")!.slice("pawster_sign_in=".length);
    expect(tokenOf(unknown)).toHaveLength(tokenOf(known).length);

    // And nothing was sent to the stranger, nor any code stored for it.
    expect(outbound.calls).toHaveLength(0);
  });

  it("answers identically when Resend refuses the send", async () => {
    /**
     * The oracle that was live until review found it.
     *
     * `sendOneTimeCodeEmail` throws on a non-2xx, and nothing caught it — so a registered
     * address got a 500 while an unregistered one, which never reaches the send, still got
     * its 303. During any Resend outage the status code told you which addresses were
     * registered: ADR 0008's exact prohibition, arriving through the one path nobody thinks
     * of as a branch.
     *
     * The interceptor makes this a two-line test, which is the argument for having one
     * dispatcher rather than three mocks.
     */
    await register();
    outbound.on("resend", () => new Response("nope", { status: 500 }));

    const known = await post("/api/refugios/codigo", {
      accountEmail: REGISTRATION.accountEmail,
    });
    const unknown = await post("/api/refugios/codigo", {
      accountEmail: "nobody@example.org",
    });

    expect(known.status).toBe(303);
    expect(known.status).toBe(unknown.status);
    expect(known.headers.get("location")).toBe(unknown.headers.get("location"));
    // It was really attempted, so this is testing the catch and not a skipped send.
    expect(outbound.callsTo("resend")).toHaveLength(1);
  });

  it("hands the unregistered address a token that opens nothing", async () => {
    // The token exists so the address never travels with the request. For a stranger it
    // names no row, so the code form's answer is the same "did not work" a wrong guess gets.
    const response = await post("/api/refugios/codigo", {
      accountEmail: "nobody@example.org",
    });
    const token = cookieFrom(response, "pawster_sign_in");

    const attempt = await post(
      "/api/refugios/sesion",
      { code: "123456" },
      { cookie: token! },
    );

    expect(attempt.status).toBe(303);
    expect(attempt.headers.get("location")).toBe("/refugios/entrar/codigo-invalido");
    expect(cookieFrom(attempt, "pawster_session")).toBeNull();
  });

  it("stores the code as an HMAC-SHA256 hash and never in plaintext", async () => {
    await register();
    const { code } = await requestCode(REGISTRATION.accountEmail);

    const db = createDb(env.DB);
    const [row] = await db.select().from(oneTimeCodes);

    expect(row).toBeDefined();
    expect(row!.codeHash).not.toBe(code);
    // Not merely "different from the plaintext": the exact construction, so a future change
    // to an unkeyed hash or a different message would fail here rather than pass quietly.
    expect(row!.codeHash).toBe(
      await hashOneTimeCode(env.SIGN_IN_SECRET, row!.shelterId, code),
    );
    // Base64url of a 256-bit digest, unpadded.
    expect(row!.codeHash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // And the plaintext appears nowhere in the row, under any column.
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it("expires the code ten minutes out", async () => {
    await register();
    const before = Date.now();
    await requestCode(REGISTRATION.accountEmail);
    const after = Date.now();

    const db = createDb(env.DB);
    const [row] = await db.select().from(oneTimeCodes);

    /**
     * Bracketed from both sides rather than given a tolerance. The endpoint stamps
     * `issuedAt + TTL` at some instant between `before` and `after`, so these two bounds pin
     * the TTL exactly however long the request took — where a one-sided check against
     * `before` is off by however many milliseconds elapsed, which is how this test first
     * failed at 600001.
     */
    const expiresAt = row!.expiresAt.getTime();
    expect(expiresAt - before).toBeGreaterThanOrEqual(ONE_TIME_CODE_TTL_MS);
    expect(expiresAt - after).toBeLessThanOrEqual(ONE_TIME_CODE_TTL_MS);
  });

  it("keeps exactly one outstanding code, and a second request kills the first", async () => {
    /**
     * ADR 0013's "one outstanding code per shelter, a new request retiring the previous one".
     * Retirement is structural rather than a step someone could forget: `one_time_codes` is
     * keyed by `shelter_id`, so writing the new code *is* destroying the old one.
     */
    await register();
    const first = await requestCode(REGISTRATION.accountEmail);
    // Ten minutes on, so this is a supersession and not a request refused by the cooldown.
    await ageMailLedger(10 * 60_000);
    outbound.reset();
    const second = await requestCode(REGISTRATION.accountEmail);

    expect(second.code).not.toBe(first.code);

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM one_time_codes").first<{
      n: number;
    }>();
    expect(row!.n).toBe(1);

    // The first code no longer works, even with the handle it was issued under.
    const stale = await post(
      "/api/refugios/sesion",
      { code: first.code },
      { cookie: first.token! },
    );
    expect(stale.headers.get("location")).toBe("/refugios/entrar/codigo-invalido");
    expect(cookieFrom(stale, "pawster_session")).toBeNull();

    // While the second one does.
    const fresh = await post(
      "/api/refugios/sesion",
      { code: second.code },
      { cookie: second.token! },
    );
    expect(fresh.headers.get("location")).toBe("/refugios/panel");
  });

  it("resets the attempt count when it supersedes a code", async () => {
    // Inherited from the retired row, four wrong guesses against a dead code would leave a
    // freshly issued one with a single attempt left.
    await register();
    const first = await requestCode(REGISTRATION.accountEmail);

    for (let i = 0; i < 4; i++) {
      await post("/api/refugios/sesion", { code: "000000" }, { cookie: first.token! });
    }

    await ageMailLedger(10 * 60_000);
    outbound.reset();
    const second = await requestCode(REGISTRATION.accountEmail);

    const db = createDb(env.DB);
    const [row] = await db.select().from(oneTimeCodes);
    expect(row!.attemptsUsed).toBe(0);

    const response = await post(
      "/api/refugios/sesion",
      { code: second.code },
      { cookie: second.token! },
    );
    expect(response.headers.get("location")).toBe("/refugios/panel");
  });
});

describe("typing the code", () => {
  it("dies after five wrong attempts, and the right code no longer works", async () => {
    await register();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);

    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= ONE_TIME_CODE_MAX_ATTEMPTS; attempt++) {
      const response = await post(
        "/api/refugios/sesion",
        { code: wrong },
        { cookie: token! },
      );
      expect(response.headers.get("location")).toBe("/refugios/entrar/codigo-invalido");
    }

    // The fifth wrong guess retired the code, so the correct digits are now worthless.
    const withRightCode = await post(
      "/api/refugios/sesion",
      { code },
      { cookie: token! },
    );
    expect(withRightCode.headers.get("location")).toBe(
      "/refugios/entrar/codigo-invalido",
    );
    expect(cookieFrom(withRightCode, "pawster_session")).toBeNull();

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM one_time_codes").first<{
      n: number;
    }>();
    expect(row!.n).toBe(0);
  });

  it("does not spend an attempt on an entry that is not a six-digit guess", async () => {
    /**
     * The ceiling bounds *guesses* at a six-digit secret, and `12` is not a guess at one.
     * Counting it would let a shelter that fat-fingered the field twice burn attempts it
     * never spent on the code.
     */
    await register();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);

    for (const entry of ["12", "abcdef", "", "1234567"]) {
      await post("/api/refugios/sesion", { code: entry }, { cookie: token! });
    }

    const db = createDb(env.DB);
    const [row] = await db.select().from(oneTimeCodes);
    expect(row!.attemptsUsed).toBe(0);

    const response = await post("/api/refugios/sesion", { code }, { cookie: token! });
    expect(response.headers.get("location")).toBe("/refugios/panel");
  });

  it("accepts a code typed with spaces", async () => {
    // A shelter reading digits off another device types `123 456` about as often as `123456`,
    // and refusing that would read to the shelter as a wrong code.
    await register();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    const response = await post(
      "/api/refugios/sesion",
      { code: spaced },
      { cookie: token! },
    );
    expect(response.headers.get("location")).toBe("/refugios/panel");
  });

  it("is single use: the same code cannot begin a second session", async () => {
    await register();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);

    const first = await post("/api/refugios/sesion", { code }, { cookie: token! });
    expect(first.headers.get("location")).toBe("/refugios/panel");

    const replay = await post("/api/refugios/sesion", { code }, { cookie: token! });
    expect(replay.headers.get("location")).toBe("/refugios/entrar/codigo-invalido");
    expect(cookieFrom(replay, "pawster_session")).toBeNull();
  });

  it("refuses a code submitted with no handle at all", async () => {
    await register();
    const { code } = await requestCode(REGISTRATION.accountEmail);

    const response = await post("/api/refugios/sesion", { code });
    expect(response.headers.get("location")).toBe("/refugios/entrar/codigo-invalido");
    expect(cookieFrom(response, "pawster_session")).toBeNull();
  });

  it("clears the handle once it has been spent", async () => {
    // The token is a bearer credential: possession of it plus six digits is a session, so it
    // does not outlive the code it names.
    await register();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);

    const response = await post("/api/refugios/sesion", { code }, { cookie: token! });
    const cleared = response.headers
      .getSetCookie()
      .find((header) => header.startsWith("pawster_sign_in="));

    expect(cleared).toContain("Max-Age=0");
  });
});

describe("the session", () => {
  it("lets a newly registered shelter in, while nothing of its is publicly visible", async () => {
    const { shelterId, cookie } = await signIn();

    const panel = await get("/refugios/panel", cookie);
    const html = await panel.text();

    expect(panel.status).toBe(200);
    expect(html).toContain("Refugio Los Teques");
    expect(html).toContain("Todavía no se ve nada de lo tuyo");

    /**
     * And it is invisible by the *listing rule* rather than by a notice that happens to say
     * so. `isListed()` is the same function the public listing uses, and the clause that
     * fires is verification: registration wrote no entry, so the shelter is pending (ADR
     * 0003) and no animal of its could be shown whatever else were true.
     */
    const facts = await readShelterFacts(createDb(env.DB), shelterId);
    expect(facts).not.toBeNull();
    expect(facts!.latestVerificationOutcome).toBeNull();
    expect(facts!.contactPointCount).toBeGreaterThan(0);
    expect(isListed({ availability: "Available" }, facts!)).toBe(false);
  });

  it("carries the shelter id, an issued-at and the epoch, and no session table exists", async () => {
    const { shelterId, cookie } = await signIn();

    const value = cookie.slice("pawster_session=".length);
    const [payload] = value.split(".");
    const claims = JSON.parse(
      atob(payload!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload!.length / 4) * 4, "=")),
    ) as Record<string, unknown>;

    // Exactly three claims — a cookie that grew a fourth would be carrying state that
    // belongs in the database.
    expect(Object.keys(claims).sort()).toEqual(["e", "i", "s"]);
    expect(claims.s).toBe(shelterId);
    expect(claims.e).toBe(0);
    expect(typeof claims.i).toBe("number");

    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    // `sqlite_sequence` is SQLite's own bookkeeping for the AUTOINCREMENT column in
    // `d1_migrations`, not a table anything here created.
    const tables = results
      .map((row) => row.name)
      .filter((name) => !name.startsWith("_") && !name.startsWith("sqlite_"));

    /**
     * There is no session table, and that is the design: revocation is one integer on the
     * shelter row, so there is nothing to delete from and no list of active sessions.
     *
     * The `upload_session` tables are excluded rather than accepted into the check, because
     * they are a different concept that happens to share the word — an Upload Session is a
     * shelter's in-progress photos (`CONTEXT.md`), not a signed-in browser, and it has rows
     * for the same reason a Session must not: something has to hold the photos. Everything
     * this assertion is actually about — a row per signed-in browser, a list to walk on
     * revocation — remains absent.
     */
    const authSessionTables = tables.filter(
      (name) => name.includes("session") && !name.startsWith("upload_session"),
    );
    expect(authSessionTables).toEqual([]);
    expect(tables).toEqual([
      "animals",
      "d1_migrations",
      "do_not_contact",
      "one_time_codes",
      "opt_in_mails",
      "pending_opt_ins",
      "shelter_contact_points",
      "shelters",
      "sign_in_requests",
      "storage_measurements",
      "subscribers",
      "subscriptions",
      "transformation_spends",
      "upload_session_photos",
      "upload_sessions",
    ]);
  });

  it("turns a shelter away from the panel with no cookie, a forged one, or none of ours", async () => {
    await register();

    for (const cookie of [
      undefined,
      "pawster_session=not-even-two-parts",
      "pawster_session=eyJzIjoiYSIsImkiOjAsImUiOjB9.forged",
    ]) {
      const response = await get("/refugios/panel", cookie);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/refugios/entrar");
    }
  });

  it("re-issues an aged cookie and writes nothing to the database", async () => {
    /**
     * The sliding half of a sliding session. The cookie is minted here rather than aged in
     * place, because the alternative is waiting a day: `encodeSession` takes the issued-at as
     * an argument precisely so that nothing has to.
     */
    const { shelterId } = await signIn();
    const aged = await encodeSession(env.SESSION_SECRET, {
      shelterId,
      issuedAt: new Date(Date.now() - SESSION_REFRESH_AFTER_MS - 1_000),
      epoch: 0,
    });

    const before = await snapshot();
    const response = await get("/refugios/panel", `pawster_session=${aged}`);
    const after = await snapshot();

    expect(response.status).toBe(200);

    const refreshed = cookieFrom(response, "pawster_session");
    expect(refreshed).not.toBeNull();
    expect(refreshed).not.toBe(`pawster_session=${aged}`);

    /**
     * Not a row changed anywhere on the platform. That is the property ADR 0013 is buying:
     * a 90-day sliding session costs one response header per day and zero writes, which is
     * what makes it affordable against D1's free-tier write budget.
     */
    expect(after).toBe(before);
  });

  it("leaves a fresh cookie alone rather than re-issuing it on every request", async () => {
    const { cookie } = await signIn();

    const response = await get("/refugios/panel", cookie);
    expect(response.status).toBe(200);
    expect(cookieFrom(response, "pawster_session")).toBeNull();
  });

  it("is invalidated for every live cookie by bumping sessionEpoch", async () => {
    /**
     * Revocation, and the reason it is one integer: two cookies minted independently both
     * die on a single `UPDATE`, with no session table to walk and no list of active sessions
     * to enumerate.
     */
    const { shelterId, cookie } = await signIn();
    const second = await encodeSession(env.SESSION_SECRET, {
      shelterId,
      issuedAt: new Date(),
      epoch: 0,
    });

    expect((await get("/refugios/panel", cookie)).status).toBe(200);
    expect((await get("/refugios/panel", `pawster_session=${second}`)).status).toBe(200);

    await createDb(env.DB)
      .update(shelters)
      .set({ sessionEpoch: 1 })
      .where(eq(shelters.id, shelterId));

    for (const dead of [cookie, `pawster_session=${second}`]) {
      const response = await get("/refugios/panel", dead);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/refugios/entrar");
    }
  });

  it("signs out over POST, clearing the cookie and writing nothing", async () => {
    const { cookie } = await signIn();

    const before = await snapshot();
    const response = await post("/api/refugios/salir", {}, { cookie });
    const after = await snapshot();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(cookieFrom(response, "pawster_session")).toBe("pawster_session=");
    expect(
      response.headers.getSetCookie().find((h) => h.startsWith("pawster_session=")),
    ).toContain("Max-Age=0");

    // Signing out does not bump the epoch: ADR 0008 makes a shared account email a normal
    // way to work, so the exit button must not sign out every other device.
    expect(after).toBe(before);
  });

  it("refuses a GET to the sign-out endpoint, so a prefetcher cannot end a session", async () => {
    /**
     * The failure ADR 0008 exists to rule out, applied here: a `GET` that ended a session
     * could be fired by a mail scanner, a link prefetcher or an `<img>` on someone else's
     * page.
     */
    const { cookie } = await signIn();

    const response = await get("/api/refugios/salir", cookie);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(cookieFrom(response, "pawster_session")).toBeNull();
    // And the session still works.
    expect((await get("/refugios/panel", cookie)).status).toBe(200);
  });
});

describe("the mail budget", () => {
  it("tells the shelter to come back later at the global ceiling, and sends nothing", async () => {
    /**
     * ADR 0013: "When the ceiling is hit the honest behaviour is to tell the shelter to try
     * tomorrow, never to eat the digest."
     *
     * The ledger is seeded directly rather than by making twenty real requests, because
     * twenty requests would trip the five-minute per-address cooldown long before the global
     * ceiling and would be testing the wrong limit.
     */
    await register();

    const statements = Array.from({ length: SIGN_IN_GLOBAL_DAILY_CEILING }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO sign_in_requests (id, shelter_id, ip_hash, mail_sent, requested_at) VALUES (?, NULL, ?, 1, ?)",
      ).bind(`seed-${i}`, `other-ip-${i}`, Date.now() - 60_000),
    );
    await env.DB.batch(statements);

    outbound.reset();
    const response = await post("/api/refugios/codigo", {
      accountEmail: REGISTRATION.accountEmail,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/refugios/entrar/espera");
    expect(outbound.calls).toHaveLength(0);

    // No code was issued either, so nothing is left behind that a later request could use.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM one_time_codes").first<{
      n: number;
    }>();
    expect(row!.n).toBe(0);
  });

  it("says so on that page, without naming any address", async () => {
    const asset = await env.ASSETS.fetch(`${ORIGIN}/refugios/entrar/espera`);
    const html = await asset.text();

    expect(asset.status).toBe(200);
    expect(html).toContain("en unas horas");
    expect(html).toContain("No es nada que hayas hecho tú");
  });

  it("refuses a registered and an unregistered address identically at the ceiling", async () => {
    // The ceiling is platform-wide state rather than a fact about any address, which is what
    // lets it be reported at all without becoming an enumeration oracle.
    await register();
    await env.DB.batch(
      Array.from({ length: SIGN_IN_GLOBAL_DAILY_CEILING }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO sign_in_requests (id, shelter_id, ip_hash, mail_sent, requested_at) VALUES (?, NULL, ?, 1, ?)",
        ).bind(`seed-${i}`, `other-ip-${i}`, Date.now() - 60_000),
      ),
    );

    const known = await post("/api/refugios/codigo", {
      accountEmail: REGISTRATION.accountEmail,
    });
    const unknown = await post("/api/refugios/codigo", {
      accountEmail: "nobody@example.org",
    });

    expect(unknown.status).toBe(known.status);
    expect(unknown.headers.get("location")).toBe(known.headers.get("location"));
    expect(unknown.headers.getSetCookie()).toEqual(known.headers.getSetCookie());
    expect(outbound.calls).toHaveLength(0);
  });

  it("silently declines a second code inside five minutes, answering as though it sent one", async () => {
    /**
     * The per-address cooldown must **not** be reported. Telling a caller it is inside a
     * five-minute window confirms the address is registered, which is exactly the oracle the
     * identical response exists to close. So the shelter gets the ordinary success response
     * and no second email.
     */
    await register();
    const first = await requestCode(REGISTRATION.accountEmail);
    outbound.reset();

    const second = await post("/api/refugios/codigo", {
      accountEmail: REGISTRATION.accountEmail,
    });

    expect(second.status).toBe(first.response.status);
    expect(second.headers.get("location")).toBe(
      first.response.headers.get("location"),
    );
    expect(outbound.calls).toHaveLength(0);

    // The first code is untouched, so the shelter that did receive one can still use it.
    const stillWorks = await post(
      "/api/refugios/sesion",
      { code: first.code },
      { cookie: first.token! },
    );
    expect(stillWorks.headers.get("location")).toBe("/refugios/panel");
  });

  it("records one ledger row per request, sent or not", async () => {
    await register();
    await requestCode(REGISTRATION.accountEmail, { ip: "198.51.100.7" });
    outbound.reset();
    await post(
      "/api/refugios/codigo",
      { accountEmail: "nobody@example.org" },
      { ip: "198.51.100.7" },
    );

    const { results } = await env.DB.prepare(
      "SELECT shelter_id, mail_sent FROM sign_in_requests ORDER BY requested_at",
    ).all<{ shelter_id: string | null; mail_sent: number }>();

    expect(results).toHaveLength(2);
    // The send is attributed; the stranger's request is recorded with no shelter, so the
    // table's contents are not themselves an enumeration oracle.
    expect(results.filter((row) => row.mail_sent === 1)).toHaveLength(1);
    expect(results.find((row) => row.mail_sent === 0)!.shelter_id).toBeNull();
    // The address is nowhere in the row — only a fingerprint of the caller's IP.
    const row = await env.DB.prepare("SELECT * FROM sign_in_requests LIMIT 1").first();
    expect(JSON.stringify(row)).not.toContain("refugio.example");
  });

  it("stops one caller before it can make the platform write without limit", async () => {
    /**
     * The per-IP limit, and the reason it counts requests rather than sends: the other three
     * limits are keyed on the shelter an address resolved to, so a caller submitting
     * addresses that resolve to nobody is invisible to all of them. It spends no mail but it
     * does spend a database write per request, and this is what bounds that.
     *
     * Once over, no further row is written — the check happens first, so the cost of a
     * refused request is one indexed `COUNT(*)`.
     */
    const attacker = "198.51.100.99";
    for (let i = 0; i < 12; i++) {
      await post(
        "/api/refugios/codigo",
        { accountEmail: `nobody-${i}@example.org` },
        { ip: attacker },
      );
    }

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM sign_in_requests").first<{
      n: number;
    }>();
    expect(row!.n).toBe(10);

    const refused = await post(
      "/api/refugios/codigo",
      { accountEmail: "nobody@example.org" },
      { ip: attacker },
    );
    /**
     * Its own page, not the global-ceiling one. This first reused `espera.astro`, whose copy
     * says "hoy ya se llegó al tope" and "no es nada que hayas hecho tú" — both false of a
     * rate-limited caller, whose own request rate is exactly what happened and whose refusal
     * has not touched the platform's mail budget at all.
     */
    expect(refused.headers.get("location")).toBe("/refugios/entrar/demasiados");
    expect(outbound.calls).toHaveLength(0);
  });

  it("counts every wrong guess even when they arrive together", async () => {
    /**
     * The five-attempt ceiling used to be a lost update: `recordFailedAttempt` read
     * `attemptsUsed`, added one in the Worker, and wrote the result back, so guesses that
     * overlapped all read the same number and all wrote the same number. That matters more
     * than an ordinary race, because guessing costs no mail — the mail caps do not bound it —
     * so an attacker holding one handle could post as fast as it liked and the code would
     * never die.
     *
     * The increment is now `attempts_used = attempts_used + 1` in SQL, which SQLite
     * serialises. Five overlapping wrong guesses therefore retire the code exactly as five
     * sequential ones do.
     */
    await register();
    const { token, code } = await requestCode(REGISTRATION.accountEmail);
    const wrong = code === "000000" ? "111111" : "000000";

    await Promise.all(
      Array.from({ length: ONE_TIME_CODE_MAX_ATTEMPTS }, () =>
        post("/api/refugios/sesion", { code: wrong }, { cookie: token! }),
      ),
    );

    // Retired, so the correct digits are now worthless.
    const withRightCode = await post(
      "/api/refugios/sesion",
      { code },
      { cookie: token! },
    );
    expect(withRightCode.headers.get("location")).toBe(
      "/refugios/entrar/codigo-invalido",
    );

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM one_time_codes").first<{
      n: number;
    }>();
    expect(row!.n).toBe(0);
  });
});

describe("the sign-in form", () => {
  it("is prerendered, so asking for a code costs the Worker nothing until the post", async () => {
    // ADR 0013: "Sign-in adds no server-rendered route. The form is static and posts to an
    // action endpoint." Asked of the asset store directly, which is what distinguishes a
    // prerendered page from one the Worker renders (see `docs/testing-seams.md`).
    for (const path of [
      "/refugios/entrar",
      "/refugios/entrar/codigo",
      "/refugios/entrar/codigo-invalido",
      "/refugios/entrar/espera",
      "/refugios/entrar/demasiados",
      "/refugios/registro/listo",
    ]) {
      const asset = await env.ASSETS.fetch(`${ORIGIN}${path}`);
      expect(asset.status, `${path} should be a static asset`).toBe(200);
    }
  });

  it("refuses a form post from another site", async () => {
    /**
     * Astro's `security.checkOrigin`, left on and pinned here rather than assumed.
     *
     * Without it, a page on any other origin could post to `/api/refugios/codigo` and spend
     * this platform's whole daily mail allocation from visitors' browsers, or post to
     * `/api/refugios/salir` and sign a shelter out. The Session cookie is `SameSite=Lax`,
     * which already withholds it from a cross-site POST, but the code-request endpoint needs
     * no cookie at all — so `Lax` protects nothing there and this check is the only thing
     * that does.
     */
    await register();

    const response = await post(
      "/api/refugios/codigo",
      { accountEmail: REGISTRATION.accountEmail },
      { origin: "https://not-pawster.example" },
    );

    expect(response.status).toBe(403);
    expect(outbound.calls).toHaveLength(0);
  });

  it("tells the shelter its answer is the same either way", async () => {
    // The enumeration rule stated to the shelter rather than only enforced: a shelter that
    // does not know the page cannot distinguish the two cases reads silence as a platform
    // fault instead of a typo in its own address.
    const asset = await env.ASSETS.fetch(`${ORIGIN}/refugios/entrar`);
    const html = await asset.text();

    expect(html).toContain("responde igual si el correo está registrado y si no lo está");
    expect(html).toContain("revisa que el correo esté bien escrito");
  });
});
