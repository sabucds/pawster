import { createDb, purgeExpiredOptIns } from "@pawster/db";
import { optInPurgeCutoff } from "@pawster/domain";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import {
  doNotContactDigest,
  hashSignupIp,
  hashSubscriberEmail,
} from "../src/lib/subscriber/crypto.ts";
import {
  MAX_SUBSCRIPTIONS_PER_SUBSCRIBER,
  OPT_IN_GLOBAL_DAILY_CEILING,
  OPT_IN_MAIL_COOLDOWN_MS,
  OPT_IN_TTL_MS,
  SIGNUP_IP_REQUEST_LIMIT,
} from "../src/lib/subscriber/policy.ts";
import { refuseContact } from "../src/lib/subscriber/store.ts";
import { get } from "./support/http.ts";
import {
  SIGNUP,
  SUBSCRIBER_EMAIL,
  activate,
  ageOptInClocks,
  clearSubscriberTables,
  countIn,
  emailedToken,
  emailedUrl,
  refuseAddress,
  rowsIn,
  signUp,
  subscribe,
} from "./support/subscriber.ts";

/**
 * Subscriber signup and opt-in, through the Worker's own front door.
 *
 * Every request here goes through `SELF.fetch()` — the whole Worker, asset router included —
 * against a real local D1 with the real migrations applied, and every email leaves through the
 * single outbound interceptor. So "exactly one opt-in email per signup" is an assertion
 * against one ordered call log rather than a question asked of a mock, and "nothing that can
 * be mailed exists yet" is a count over the real tables.
 *
 * The suite is arranged by issue #61's nine acceptance criteria, one `describe` each, because
 * several of them are only true of the *interaction* between two mechanisms — the identical
 * response is a property of five branches converging, and the cap is a property of a constant
 * and a unique index disagreeing under load. Grouping by criterion is what keeps each one
 * asserted somewhere rather than assumed by whichever unit test was nearest.
 */

const CHECK_INBOX = "/resumen/revisa-tu-correo";
const DEAD_LINK = "/resumen/enlace-vencido";
const CAPPED = "/resumen/limite";

const DAY_MS = 24 * 60 * 60_000;

/** A fixed caller, for the two tests that assert on the fingerprint of one. */
const SIGNUP_IP = "192.0.2.51";

/** The address a criteria row was written for, read back out of the join. */
async function storedCriteria(email = SUBSCRIBER_EMAIL): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.criteria AS criteria
       FROM subscriptions s
       JOIN subscribers b ON b.id = s.subscriber_id
      WHERE b.email = ?
      ORDER BY s.slot`,
  )
    .bind(email)
    .all<{ criteria: string }>();
  return results.map((row) => row.criteria);
}

beforeEach(clearSubscriberTables);

describe("1 — signing up creates nothing that can be mailed", () => {
  it("writes an unconfirmed opt-in and no subscriber", async () => {
    const response = await signUp();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(CHECK_INBOX);

    /**
     * The criterion, and it is satisfied by an absence rather than by a flag: the digest
     * reads `subscribers`, and there is no row there to read. There is no pending state on a
     * subscriber and no `confirmed` boolean for a later path to forget to check — the same
     * shape `registerShelter()` takes with the verification log it does not write to.
     */
    expect(await countIn("subscribers")).toBe(0);
    expect(await countIn("subscriptions")).toBe(0);

    expect(await countIn("pending_opt_ins")).toBe(1);
    // The ledger row is what the daily ceiling and the cooldown are counted over, and it is
    // written whether or not Resend accepts the message.
    expect(await countIn("opt_in_mails")).toBe(1);
  });

  it("holds the address in one place and only as a fingerprint elsewhere", async () => {
    await signUp();

    const [pending] = await rowsIn("pending_opt_ins");
    expect(pending!.email).toBe(SUBSCRIBER_EMAIL);

    /**
     * The ledger has to be able to answer "when did we last mail this address" without
     * holding it, or the platform would be keeping an unconsented address in a second table
     * for a question a digest answers exactly as well. ADR 0010's "only keep the minimum
     * amount of information needed".
     */
    const [ledger] = await rowsIn("opt_in_mails");
    expect(ledger!.email_hash).toBe(await hashSubscriberEmail(env, SUBSCRIBER_EMAIL));
    expect(JSON.stringify(ledger)).not.toContain(SUBSCRIBER_EMAIL);
  });

  it("becomes a subscriber only once the link is followed", async () => {
    await signUp();
    await activate(emailedToken());

    expect(await countIn("subscribers")).toBe(1);
    expect(await countIn("subscriptions")).toBe(1);
    // Consumed rather than flagged, which is what makes the link single-use — criterion 2.
    expect(await countIn("pending_opt_ins")).toBe(0);
  });
});

describe("2 — the opt-in link is single-use", () => {
  it("refuses a second use of a link that worked", async () => {
    await signUp();
    const token = emailedToken();

    const first = await activate(token);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toMatch(/^\/resumen\/listo\?dia=\d$/);

    const second = await activate(token);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(DEAD_LINK);

    // And the second use wrote nothing: one subscription, not two.
    expect(await countIn("subscriptions")).toBe(1);
  });

  it("answers an invented token exactly as it answers a spent one", async () => {
    await signUp();
    const token = emailedToken();
    await activate(token);

    const spent = await activate(token);
    const invented = await activate("bm90LWEtcmVhbC10b2tlbi1hdC1hbGw");

    /**
     * Indistinguishable, and structurally so: single use is the row's absence, so a spent
     * token finds precisely what a token that never existed finds. A page that could tell
     * them apart would need the row to survive its own redemption — the state flag
     * `consumePendingOptIn()` exists not to have.
     */
    expect(invented.status).toBe(spent.status);
    expect(invented.headers.get("location")).toBe(spent.headers.get("location"));
  });

  it("does not opt anybody in on a GET of the link", async () => {
    /**
     * ADR 0008: "a confirmation link must never mutate on `GET`. Outlook Safe Links,
     * corporate mail scanners and link prefetchers fetch URLs with no human behind them."
     * An opt-in is the sharpest case of that rule in the design — the *entire* value of a
     * double opt-in is that a person read the mail, and a scanner completing one would
     * reduce it to proof that the address exists.
     *
     * So the page is fetched the way a prefetcher would, twice, and the assertion is that
     * nothing moved and the link still works afterwards.
     */
    await signUp();
    const url = emailedUrl();

    const opened = await get(new URL(url).pathname + new URL(url).search);
    expect(opened.status).toBe(200);
    await get(new URL(url).pathname + new URL(url).search);

    expect(await countIn("subscribers")).toBe(0);
    expect(await countIn("pending_opt_ins")).toBe(1);

    const activated = await activate(emailedToken());
    expect(activated.headers.get("location")).toMatch(/^\/resumen\/listo/);
  });

  it("shows the subscriber what they are about to activate", async () => {
    await signUp({ regions: "Miranda, Aragua" });
    const url = new URL(emailedUrl());

    const page = await get(url.pathname + url.search);
    const html = await page.text();

    // Read back in the words the form offered, not in the vocabulary values it stored.
    expect(html).toContain("Perros");
    expect(html).toContain("Pequeño");
    expect(html).not.toContain("Small");

    /**
     * Sorted, because the open axis has no canonical order to sort by and so sorts
     * lexicographically — `parseCriteria()`'s rule, and the reason this reads back as
     * "aragua, miranda" rather than in the order the box was typed in. Worth asserting
     * rather than glossing: it is the one axis whose stored order is not the subscriber's.
     */
    expect(html).toContain("aragua, miranda");
  });
});

describe("3 — the signup form's response is identical on every path", () => {
  /**
   * Status, `Location` and every header a caller can read, as one comparable string.
   *
   * Every header rather than only `Location`, because the loose version of this assertion is
   * how the oracle gets back in: a `Set-Cookie` present on one branch and absent on another
   * is a signal, and so is a differing `Content-Length`. `forEach` rather than a spread,
   * because `Headers` is not typed as iterable under this lib target.
   */
  const shape = (response: Response) => {
    const headers: string[] = [];
    response.headers.forEach((value, name) => headers.push(`${name}: ${value}`));
    return JSON.stringify({ status: response.status, headers: headers.sort() });
  };

  it("answers a new, an already-subscribed and a refused address the same way", async () => {
    const newcomer = await signUp({ email: "nueva@adoptante.example" });

    // Already subscribed: opted in, then signing up again a day later for a second search.
    await subscribe({ email: "vieja@adoptante.example" });
    await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
    outbound.reset();
    const returning = await signUp({ email: "vieja@adoptante.example" });

    // Do-Not-Contact: an address that reported us as spam, refused without being told why.
    await refuseAddress("quejosa@adoptante.example");
    const refused = await signUp({ email: "quejosa@adoptante.example" });

    expect(shape(returning)).toBe(shape(newcomer));
    expect(shape(refused)).toBe(shape(newcomer));
    expect(newcomer.headers.get("location")).toBe(CHECK_INBOX);

    /**
     * And the *behaviour* behind the identical bytes differs, which is the half worth
     * asserting: the refused address was mailed nothing and left no row anywhere.
     */
    expect(outbound.callsTo("resend")).toHaveLength(1);
    // Two links outstanding — the newcomer's and the returning subscriber's second search —
    // and none for the refused address, which left no row at all.
    expect(await countIn("pending_opt_ins")).toBe(2);
  });

  it("refuses a Do-Not-Contact address in silence, writing nothing at all", async () => {
    await refuseAddress(SUBSCRIBER_EMAIL);

    const response = await signUp();

    expect(response.headers.get("location")).toBe(CHECK_INBOX);
    expect(outbound.calls).toHaveLength(0);
    expect(await countIn("pending_opt_ins")).toBe(0);
    expect(await countIn("opt_in_mails")).toBe(0);
  });

  it("matches a Do-Not-Contact entry however the address was capitalised", async () => {
    /**
     * The same normalisation on both sides is the whole of matching, and a mismatch here
     * does not fail loudly — it resumes mailing somebody who reported us as spam.
     */
    await refuseAddress(SUBSCRIBER_EMAIL);

    await signUp({ email: " Ana@Adoptante.Example " });

    expect(outbound.calls).toHaveLength(0);
    expect(await countIn("pending_opt_ins")).toBe(0);
  });

  it("stays silent inside the 24-hour cooldown", async () => {
    await signUp();
    outbound.reset();

    const again = await signUp();

    // ADR 0010: at most one opt-in mail per address per 24 hours, and telling the caller
    // about the cooldown would reveal that somebody asked about the address recently.
    expect(again.headers.get("location")).toBe(CHECK_INBOX);
    expect(outbound.calls).toHaveLength(0);
    expect(await countIn("pending_opt_ins")).toBe(1);
  });

  it("speaks the two refusals that are not about the address", async () => {
    /**
     * `SPEAKABLE_REFUSALS` as behaviour: the daily ceiling is a fact about the platform and
     * the per-IP limit is a fact about the caller, so both are said out loud. Six sends fill
     * the ceiling, and the seventh person is told to come back rather than shown a "check
     * your inbox" for mail that was never sent.
     */
    for (let n = 0; n < OPT_IN_GLOBAL_DAILY_CEILING; n++) {
      outbound.reset();
      await signUp({ email: `persona${n}@adoptante.example` });
    }

    const seventh = await signUp({ email: "septima@adoptante.example" });
    expect(seventh.headers.get("location")).toBe("/resumen/espera");

    // A refused request writes nothing, so the ceiling cannot be walked past by trying.
    expect(await countIn("pending_opt_ins")).toBe(OPT_IN_GLOBAL_DAILY_CEILING);
  });

  it("sends a caller over the per-IP limit to its own page", async () => {
    const ip = "198.51.100.7";

    /**
     * The limit counts pending rows rather than requests — ADR 0010 allows one table to hold
     * an IP, so there is no request ledger to count — which means filling it takes as many
     * distinct addresses as it takes rows. Each also spends one of the day's six sends, so
     * the ledger is aged between them.
     */
    for (let n = 0; n < SIGNUP_IP_REQUEST_LIMIT; n++) {
      outbound.reset();
      await signUp({ email: `masiva${n}@adoptante.example` }, { ip });
      await env.DB.prepare("UPDATE opt_in_mails SET sent_at = sent_at - ?")
        .bind(DAY_MS + 1)
        .run();
    }

    const refused = await signUp({ email: "ultima@adoptante.example" }, { ip });
    expect(refused.headers.get("location")).toBe("/resumen/demasiados");

    // Another caller is unaffected: the bucket is the address, not the platform.
    const other = await signUp({ email: "otra@adoptante.example" });
    expect(other.headers.get("location")).toBe(CHECK_INBOX);
  });

  it("says so when the address is not an address, which reveals nothing", async () => {
    /**
     * The one thing about the submitted field that *is* spoken. The identical-response rule
     * closes an enumeration oracle — whether an address belongs to a subscriber — and
     * "this is not shaped like an email" answers nothing about anybody's inbox. Silence here
     * is what leaves an adopter with a typo waiting three days for mail.
     */
    const response = await signUp({ email: "ana@gmial" });

    expect(response.headers.get("location")).toBe("/resumen/correo-invalido");
    // And it costs the platform nothing: no hashes, no queries, no row.
    expect(await countIn("pending_opt_ins")).toBe(0);
    expect(outbound.calls).toHaveLength(0);
  });
});

describe("4 — a fourth subscription is refused", () => {
  it("stops mailing a link once the address holds three", async () => {
    for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_SUBSCRIBER; n++) {
      await subscribe({ regions: `region-${n}` });
      await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
    }
    expect(await countIn("subscriptions")).toBe(MAX_SUBSCRIPTIONS_PER_SUBSCRIBER);

    outbound.reset();
    const fourth = await signUp({ regions: "region-3" });

    /**
     * The *early* refusal, and what it buys is the send: without it the platform spends one
     * of six daily emails on a subscription that would be rejected at the end of it. Refused
     * silently, because "this address already holds three" is a fact about the address.
     */
    expect(fourth.headers.get("location")).toBe(CHECK_INBOX);
    expect(outbound.calls).toHaveLength(0);
    expect(await countIn("pending_opt_ins")).toBe(0);
  });

  it("leaves a refused link intact so the subscriber can free a slot and use it", async () => {
    /**
     * The ordering on `activar.astro`: the row is read and judged *before* it is consumed, so
     * a link that arrives at a full account is not destroyed on the way to being told so.
     * Without that, `limite.astro`'s advice — swap one of your three for this — is
     * unactionable, because the criteria it offers to swap in went with the row.
     */
    await signUp({ regions: "esperando" });
    const held = emailedToken();

    for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_SUBSCRIBER; n++) {
      await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
      await subscribe({ regions: `llena-${n}` });
    }

    expect(await activate(held)).toMatchObject({ status: 303 });
    // Still outstanding, not spent.
    expect(await countIn("pending_opt_ins")).toBe(1);

    // A slot frees up, and the link the subscriber was already holding works.
    await env.DB.prepare("DELETE FROM subscriptions WHERE slot = 2").run();
    const late = await activate(held);
    expect(late.headers.get("location")).toMatch(/^\/resumen\/listo/);

    const criteria = await storedCriteria();
    expect(criteria.some((row) => row.includes("esperando"))).toBe(true);
  });

  it("refuses a link that was live when the account filled up behind it", async () => {
    /**
     * The case `refuseSignup()` cannot see, because up to seven days pass between the mail
     * and the click. Two links are taken out while the account has room, the account is then
     * filled, and the second link arrives at a full account — which is not a failure but the
     * cap being enforced at the only moment it can be enforced for certain.
     */
    await signUp({ regions: "primera" });
    const held = emailedToken();

    for (let n = 0; n < MAX_SUBSCRIPTIONS_PER_SUBSCRIBER; n++) {
      await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
      await subscribe({ regions: `llena-${n}` });
    }

    const late = await activate(held);
    expect(late.status).toBe(303);
    expect(late.headers.get("location")).toBe(CAPPED);

    expect(await countIn("subscriptions")).toBe(MAX_SUBSCRIPTIONS_PER_SUBSCRIBER);
  });

  it("counts the cap per address rather than per platform", async () => {
    await subscribe({ email: "una@adoptante.example" });
    await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
    await subscribe({ email: "otra@adoptante.example" });

    expect(await countIn("subscribers")).toBe(2);
    expect(await countIn("subscriptions")).toBe(2);
  });
});

describe("5 — criteria are stored as sets, and a subscription can name several regions", () => {
  it("keeps every region a subscriber named", async () => {
    await subscribe({ regions: "Miranda, Distrito Capital, Aragua" });

    const [criteria] = await storedCriteria();
    const parsed = JSON.parse(criteria!) as Record<string, string[]>;

    /**
     * ADR 0005 requires this axis specifically: a subscriber in the Caracas commuter belt
     * watches three states at once, and a scalar per axis would have made that three of their
     * three subscriptions — a whole allowance spent on the word *or*.
     */
    expect(parsed.regions).toEqual(["aragua", "distrito capital", "miranda"]);
  });

  it("keeps every axis as a set and drops nothing a form could send", async () => {
    await subscribe({
      species: ["dog", "cat"],
      sizes: ["Giant", "Small"],
      sexes: ["Female"],
      ageBands: ["Adult", "Puppy"],
      goodWith: ["children", "cats"],
      regions: "zulia",
    });

    const parsed = JSON.parse((await storedCriteria())[0]!) as Record<string, string[]>;

    /**
     * Canonical order, not submission order: `parseCriteria()` sorts by position in each
     * vocabulary, so a size list reads smallest-first and a band list reads by life stage.
     * That is what a subscriber sees on the opt-in page and will see on the manage page.
     */
    expect(parsed).toEqual({
      species: ["dog", "cat"],
      sizes: ["Small", "Giant"],
      sexes: ["Female"],
      ageBands: ["Puppy", "Adult"],
      goodWith: ["children", "cats"],
      regions: ["zulia"],
    });
  });

  it("stores the same JSON string for two subscribers who ticked the same boxes", async () => {
    /**
     * Canonical as a *string* and not merely as a value, which is what lets two rows be
     * compared with `=` — the sent-set and the manage page both end up wanting that, and it
     * would quietly stop working the first time a caller built its object in another order.
     */
    await subscribe({ email: "primera@adoptante.example", species: ["cat", "dog"] });
    await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
    await subscribe({ email: "segunda@adoptante.example", species: ["dog", "cat"] });

    const [first] = await storedCriteria("primera@adoptante.example");
    const [second] = await storedCriteria("segunda@adoptante.example");
    expect(first).toBe(second);
  });

  it("accepts an empty criteria as the form promises: everything", async () => {
    /**
     * `criteria.ts` leaves this judgement to the caller, because an empty set is legitimate
     * for the digest and a probable mistake at a form. The signup form resolves it by saying
     * in so many words that ticking nothing means every animal, so a subscriber who ticks
     * nothing has been told what they asked for.
     */
    await subscribe({ species: [], sizes: [], regions: "" });

    expect(await storedCriteria()).toEqual(["{}"]);
  });

  it("stores the locale the page carried, for the one mail with no URL to read it off", async () => {
    await subscribe();

    const [subscriber] = await rowsIn("subscribers");
    expect(subscriber!.locale).toBe("es");
  });
});

describe("6 — the send day is assigned at opt-in to the least-loaded weekday", () => {
  it("fills all seven days before giving anybody a second one", async () => {
    const days: number[] = [];
    for (let n = 0; n < 7; n++) {
      await ageOptInClocks(DAY_MS + 1);
      days.push(await subscribe({ email: `dia${n}@adoptante.example` }));
    }

    // Seven subscribers, seven distinct days: the load table is read fresh each time, so
    // each new subscriber lands on a day nobody holds yet.
    expect([...days].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);

    await ageOptInClocks(DAY_MS + 1);
    const eighth = await subscribe({ email: "octava@adoptante.example" });
    // A tie across all seven, broken on the lowest index — deterministic on purpose, so the
    // assignment stays reproducible from the load table it was derived from.
    expect(eighth).toBe(0);
  });

  it("gives a day emptied by an erasure to the next subscriber", async () => {
    for (let n = 0; n < 7; n++) {
      await ageOptInClocks(DAY_MS + 1);
      await subscribe({ email: `base${n}@adoptante.example` });
    }

    /**
     * Least-loaded rather than a round-robin counter, because the balance then **repairs
     * itself**: ADR 0010 makes erasure ordinary rather than exceptional, so days develop
     * holes, and a counter would keep handing out days in rotation while the population
     * stayed lopsided.
     */
    await env.DB.prepare("DELETE FROM subscriptions WHERE subscriber_id IN (SELECT id FROM subscribers WHERE send_day = 4)").run();
    await env.DB.prepare("DELETE FROM subscribers WHERE send_day = 4").run();

    await ageOptInClocks(DAY_MS + 1);
    expect(await subscribe({ email: "hueco@adoptante.example" })).toBe(4);
  });

  it("keeps a subscriber's day when they add a second search", async () => {
    const first = await subscribe();
    await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
    const second = await subscribe({ regions: "aragua" });

    /**
     * `CONTEXT.md` makes the day "fixed at opt-in and the same every week" and a property of
     * the subscriber rather than of the search — three saved searches arrive in one email, so
     * a second subscription that moved the day would move the first one's mail too.
     */
    expect(second).toBe(first);
    expect(await countIn("subscribers")).toBe(1);
    expect(await countIn("subscriptions")).toBe(2);
  });
});

describe("7 — an unconfirmed opt-in and its IP are gone after seven days", () => {
  it("destroys the row and kills the link at the same moment", async () => {
    /**
     * The caller's address is given explicitly rather than left to the support file's
     * rotating default, because this assertion is about the *fingerprint* and so has to know
     * what was fingerprinted.
     */
    await signUp({}, { ip: SIGNUP_IP });
    const token = emailedToken();
    const ipHash = (await rowsIn("pending_opt_ins"))[0]!.ip_hash;
    expect(ipHash).toBe(await hashSignupIp(env, SIGNUP_IP));

    await ageOptInClocks(OPT_IN_TTL_MS + 1);

    const db = createDb(env.DB);
    const destroyed = await purgeExpiredOptIns(db, optInPurgeCutoff(new Date()));

    expect(destroyed).toBe(1);
    expect(await countIn("pending_opt_ins")).toBe(0);

    /**
     * One constant serves both the link's lifetime and the purge cutoff, so "the link stops
     * working exactly when the row is due for destruction" is true by construction rather
     * than by two facts agreeing. Asserted from the outside: the link is dead too.
     */
    const late = await activate(token);
    expect(late.headers.get("location")).toBe(DEAD_LINK);
  });

  it("leaves a link inside its seven days alone", async () => {
    await signUp();
    await ageOptInClocks(OPT_IN_TTL_MS - DAY_MS);

    const db = createDb(env.DB);
    expect(await purgeExpiredOptIns(db, optInPurgeCutoff(new Date()))).toBe(0);
    expect(await countIn("pending_opt_ins")).toBe(1);
  });
});

describe("8 — the IP is stored on no other record", () => {
  it("keeps no trace of the caller once the opt-in is confirmed", async () => {
    /**
     * ADR 0010: "IP is recorded only on the *unconfirmed* row, where it serves rate limiting,
     * and dies with the seven-day purge. Confirmed subscribers carry no IP at all."
     *
     * `db/test/migrations.test.ts` asserts the *schema* side of this criterion — that
     * `pending_opt_ins` is the only subscriber table with such a column. This is the other
     * half, and the one a new ledger would slip past: that the fingerprint is actually gone
     * from every row the platform holds once the subscriber exists.
     */
    await signUp({}, { ip: SIGNUP_IP });
    const ipHash = await hashSignupIp(env, SIGNUP_IP);
    expect(JSON.stringify(await rowsIn("pending_opt_ins"))).toContain(ipHash);

    await activate(emailedToken());

    for (const table of [
      "subscribers",
      "subscriptions",
      "pending_opt_ins",
      "opt_in_mails",
      "do_not_contact",
    ]) {
      expect(JSON.stringify(await rowsIn(table)), table).not.toContain(ipHash);
    }
  });
});

describe("9 — exactly one opt-in email per signup", () => {
  it("sends one message, to the submitted address, carrying the link", async () => {
    await signUp();

    const calls = outbound.callsTo("resend");
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    const body = JSON.parse(call.body!) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };

    expect(body.to).toEqual([SUBSCRIBER_EMAIL]);
    // The digest's sender, not sign-in's: this is the first message of the digest
    // relationship, so a subscriber who allow-lists it once is done.
    expect(body.from).toBe("digest@pawster.test");
    expect(body.text).toContain("https://pawster.test/resumen/activar?t=");

    /**
     * **No idempotency key**, and it is the opposite of the digest's choice for the reason
     * `mail.ts` records: a signup is not a retry of anything, so two signups a day apart must
     * produce two emails. A key over the address and the day would have swallowed the second
     * and left a subscriber holding a link to a row nobody wrote.
     */
    expect(call.headers["idempotency-key"]).toBeUndefined();
  });

  it("sends nothing at all on any silent refusal", async () => {
    await refuseAddress(SUBSCRIBER_EMAIL);

    await signUp();
    await signUp({ email: "ana@gmial" });

    expect(outbound.calls).toHaveLength(0);
  });

  it("still answers identically when Resend refuses the message", async () => {
    /**
     * The catch in `suscribir.ts`, and the reason the identical-response rule actually holds
     * rather than nearly holds. Without it a Resend outage turns the send's throw into a 500
     * — but only on the branch a refused address never reaches, which is a working
     * enumeration oracle: submit an address during any outage and the status code says
     * whether it was on the Do-Not-Contact list.
     */
    outbound.on("resend", () => new Response("nope", { status: 500 }));

    const response = await signUp();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(CHECK_INBOX);

    // The rows stay written: the pending row is a link nobody received, which the purge
    // takes, and the ledger row is an allowance spent — a retry loop must not be free.
    expect(await countIn("pending_opt_ins")).toBe(1);
    expect(await countIn("opt_in_mails")).toBe(1);
  });

  it("sends a second link for a second search, a day later", async () => {
    await signUp();
    await ageOptInClocks(OPT_IN_MAIL_COOLDOWN_MS + 1);
    await signUp({ regions: "aragua" });

    expect(outbound.callsTo("resend")).toHaveLength(2);
    expect(await countIn("pending_opt_ins")).toBe(2);
  });
});

describe("the Do-Not-Contact pepper canary", () => {
  it("writes itself on the first signup the platform ever handles", async () => {
    expect(await countIn("do_not_contact")).toBe(0);

    await signUp();

    const [canary] = await rowsIn("do_not_contact");
    expect(canary!.reason).toBe("canary");
  });

  it("refuses to bootstrap beside entries it cannot vouch for", async () => {
    /**
     * The one-step version of the failure the canary exists to catch: delete the canary row
     * and the next signup would happily write a fresh one under whatever pepper is configured
     * now, while every real entry beside it has silently stopped matching. Bootstrapping only
     * into an *empty* table closes it — a table with no entries has nothing that can fail
     * open, and a table with entries and no canary is a state nobody should be able to serve
     * a signup from.
     */
    const db = createDb(env.DB);
    await refuseContact(
      db,
      await doNotContactDigest(env, "quejosa@adoptante.example"),
      new Date(),
    );
    expect(await countIn("do_not_contact")).toBe(1);

    const response = await signUp();

    expect(response.status).toBe(500);
    expect(outbound.calls).toHaveLength(0);
    // And no canary was invented to paper over it.
    expect(await countIn("do_not_contact")).toBe(1);
  });

  it("refuses to serve a signup once the pepper has changed underneath it", async () => {
    /**
     * ADR 0010's failure mode is silence: a wrong pepper matches nobody, the list appears
     * empty, and the platform resumes mailing people who reported it as spam with no alarm
     * anywhere. The canary turns that into a 500 on the one path whose correctness depends on
     * the list — loud, and loud in the right direction, since no mail goes out while it
     * stands.
     *
     * A rotation is simulated the only way a test can: by writing a canary the configured
     * pepper cannot produce, which is exactly the state a rotated secret leaves behind.
     */
    await env.DB.prepare(
      "INSERT INTO do_not_contact (digest, reason, recorded_at) VALUES (?, ?, ?)",
    )
      .bind("a-digest-from-some-other-pepper", "canary", 0)
      .run();

    const response = await signUp();

    expect(response.status).toBe(500);
    expect(outbound.calls).toHaveLength(0);
    expect(await countIn("pending_opt_ins")).toBe(0);
  });
});

describe("the signup form itself", () => {
  it("is a static asset, so the Worker does not run to render it", async () => {
    /**
     * ADR 0007's governing rule, asserted the way `routing.test.ts` asserts it for the home
     * page: this is the page every link to Pawster's digest points at, and a server-rendered
     * one would spend an invocation per visit on a form that never varies.
     */
    const asset = await env.ASSETS.fetch("https://pawster.test/resumen");
    expect(asset.status).toBe(200);
  });

  it("renders a checkbox for every value in every closed vocabulary", async () => {
    const page = await get("/resumen");
    const html = await page.text();

    for (const value of ["dog", "cat", "Small", "Giant", "Female", "Unknown", "Puppy", "Kitten", "children"]) {
      expect(html, value).toContain(`value="${value}"`);
    }

    // And the two things the form has to say out loud: that ticking nothing means
    // everything, and that the first mail is a link rather than animals.
    expect(html).toContain("everything-notice");
    expect(html).toContain("opt-in-notice");
  });

  it("is indexable, unlike every page it leads to", async () => {
    const form = await (await get("/resumen")).text();
    const outcome = await (await get(CHECK_INBOX)).text();

    expect(form).not.toContain('name="robots"');
    expect(outcome).toContain('content="noindex"');
  });
});
