import {
  MANAGE_PATH,
  UNSUBSCRIBE_PATH,
  manageToken,
  unsubscribeToken,
  verifyManageToken,
} from "@pawster/domain";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { doNotContactDigest } from "../src/lib/subscriber/crypto.ts";
import { ORIGIN, get, post } from "./support/http.ts";
import {
  SUBSCRIBER_EMAIL,
  clearSubscriberTables,
  countIn,
  rowsIn,
  subscribe,
} from "./support/subscriber.ts";

/**
 * Issue #62: everything a subscriber can do to their own data, without an account and without
 * writing to anyone.
 *
 * The suite goes through `SELF.fetch()` against the real routes and a real local D1 with the
 * real migrations applied, because almost every acceptance criterion here is a statement about
 * an HTTP response — a `GET` that mutates, a `POST` that answers 202, a link that stops
 * working — and none of those is observable from a function call.
 */

/** The subscriber just created, read straight out of the table. */
async function subscriberRow(): Promise<Record<string, unknown>> {
  const [row] = await rowsIn("subscribers");
  expect(row, "a subscriber should exist").toBeDefined();
  return row!;
}

async function manageLinkFor(id: string, version: number): Promise<string> {
  return `${MANAGE_PATH}/${await manageToken(env, { subscriberId: id, version })}`;
}

async function unsubscribeLinkFor(id: string): Promise<string> {
  return `${UNSUBSCRIBE_PATH}/${await unsubscribeToken(env, id)}`;
}

/** Sign up, activate, and come back with the subscriber's id and live manage link. */
async function subscribedWithLink(): Promise<{ id: string; manage: string }> {
  await subscribe();
  const row = await subscriberRow();
  const id = row.id as string;
  return {
    id,
    manage: await manageLinkFor(id, row.manage_token_version as number),
  };
}

beforeEach(async () => {
  await clearSubscriberTables();
  outbound.reset();
});

describe("1 — the manage page is the subject-access response", () => {
  it("shows every field Pawster holds about the subscriber", async () => {
    const { manage } = await subscribedWithLink();

    const response = await get(manage);
    expect(response.status).toBe(200);
    const html = await response.text();

    // The address, the day, when they opted in, and what we have and have not done since.
    expect(html).toContain(SUBSCRIBER_EMAIL);
    for (const field of [
      "held-email",
      "held-opted-in",
      "held-send-day",
      "held-last-digest",
      "held-locale",
      "held-nudged",
      "held-unsubscribed",
      "held-retired",
    ]) {
      expect(html, `the page should disclose ${field}`).toContain(field);
    }
  });

  /**
   * The promise `ManageView` exists to keep. ADR 0010 makes this page the whole of the
   * subject-access response, so a column added to `subscribers` and not to the page is a
   * column the platform has quietly stopped disclosing — and nothing else would catch it.
   *
   * The test reads the live schema rather than a list written here, because a hand-written
   * list is the same drift one step removed.
   */
  it("discloses every column of the subscribers table, or names the exemption", async () => {
    /**
     * `id` and `manage_token_version` are addresses rather than facts about a person, and the
     * page says so in its own words instead of as raw values; `email` is asserted above by its
     * value. Everything else must appear as a labelled row.
     */
    const SHOWN_ELSEWHERE = new Set(["id", "email", "manage_token_version"]);
    const LABELS: Record<string, string> = {
      send_day: "held-send-day",
      opted_in_at: "held-opted-in",
      last_digest_at: "held-last-digest",
      locale: "held-locale",
      unsubscribed_at: "held-unsubscribed",
      retired_at: "held-retired",
      retirement_reason: "held-retired",
      nudged_at: "held-nudged",
    };

    const { manage } = await subscribedWithLink();
    const html = await (await get(manage)).text();

    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('subscribers')",
    ).all<{ name: string }>();

    for (const { name } of results) {
      if (SHOWN_ELSEWHERE.has(name)) continue;
      const label = LABELS[name];
      expect(
        label,
        `subscribers.${name} is not disclosed on the manage page, and the manage page is the ` +
          "subject-access response (ADR 0010). Add a row for it, or add it to SHOWN_ELSEWHERE " +
          "with a reason.",
      ).toBeDefined();
      expect(html).toContain(label!);
    }
  });

  it("shows the saved searches themselves", async () => {
    const { manage } = await subscribedWithLink();
    const html = await (await get(manage)).text();
    expect(html).toContain("subscriptions");
    // The signup fixture ticks dogs and two sizes, so the criteria must render as words.
    expect(html).toContain("Perro");
  });

  it("refuses a token we did not sign", async () => {
    const { id } = await subscribedWithLink();
    const forged = `${MANAGE_PATH}/${id}.0.bm90LWEtcmVhbC1zaWduYXR1cmU`;
    const response = await get(forged);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/resumen/enlace-vencido");
  });

  it("answers the same way for a subscriber who does not exist", async () => {
    // Otherwise the page is an oracle for which subscriber ids are real.
    const link = await manageLinkFor("3f2a1c44-0000-4000-8000-00000000dead", 0);
    const response = await get(link);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/resumen/enlace-vencido");
  });
});

describe("2 — one-click unsubscribe", () => {
  it("unsubscribes on load from a GET, with no confirmation page", async () => {
    const { id } = await subscribedWithLink();

    const response = await get(await unsubscribeLinkFor(id));

    // 200 and not a redirect to a "are you sure?" page: a one-click header that needs a
    // second click is not one-click.
    expect(response.status).toBe(200);
    expect((await subscriberRow()).unsubscribed_at).not.toBeNull();
  });

  it("answers 202 with no body on the POST, which is what RFC 8058 sends", async () => {
    const { id } = await subscribedWithLink();

    const response = await post(await unsubscribeLinkFor(id), {});

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect((await subscriberRow()).unsubscribed_at).not.toBeNull();
  });

  it("answers 202 even for a token that verifies against nobody", async () => {
    // The caller is a mail client that can neither act on the difference nor be trusted with
    // it, and a 404 would say which subscriber ids exist.
    const response = await post(`${UNSUBSCRIBE_PATH}/not-a-real-token`, {});
    expect(response.status).toBe(202);
  });

  it("keeps the subscriptions, because unsubscribing is not erasure", async () => {
    const { id } = await subscribedWithLink();

    await get(await unsubscribeLinkFor(id));

    // ADR 0010: the ninety-day grace period is what makes a prefetcher's click survivable.
    expect(await countIn("subscribers")).toBe(1);
    expect(await countIn("subscriptions")).toBe(1);
  });

  it("does not push the erasure date further out when the link is followed twice", async () => {
    const { id } = await subscribedWithLink();
    const link = await unsubscribeLinkFor(id);

    await get(link);
    const first = (await subscriberRow()).unsubscribed_at;
    await get(link);

    // A prefetcher followed by the person is two visits, and the clock must start at the
    // first — otherwise the grace period is unbounded for whoever clicks most.
    expect((await subscriberRow()).unsubscribed_at).toBe(first);
  });

  it("rotates the manage token, killing every manage link handed out before it", async () => {
    const { id, manage } = await subscribedWithLink();

    await get(await unsubscribeLinkFor(id));

    const response = await get(manage);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/resumen/enlace-vencido");
  });

  it("carries the delete-everything button on the landing page", async () => {
    const { id } = await subscribedWithLink();

    const html = await (await get(await unsubscribeLinkFor(id))).text();

    // ADR 0010: the rotation leaves this as the unsubscribed subscriber's only route, so the
    // button has to be *here* and has to carry the versionless token.
    expect(html).toContain("erase");
    expect(html).toContain('action="/resumen/borrar"');
    expect(html).toContain(await unsubscribeToken(env, id));
  });

  it("still works from a link that was already used, because nothing here expires", async () => {
    const { id } = await subscribedWithLink();
    const link = await unsubscribeLinkFor(id);

    await get(link);
    // The header is in every digest ever delivered; a subscriber may press it a year later.
    expect((await get(link)).status).toBe(200);
  });
});

describe("3 — erasure is a separate, explicit ask", () => {
  it("destroys the subscriber and their searches", async () => {
    const { id } = await subscribedWithLink();

    const response = await post("/resumen/borrar", {
      t: await unsubscribeToken(env, id),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/resumen/borrado");
    expect(await countIn("subscribers")).toBe(0);
    expect(await countIn("subscriptions")).toBe(0);
  });

  it("works from the manage page's own token too", async () => {
    const { id } = await subscribedWithLink();
    const row = await subscriberRow();

    const response = await post("/resumen/borrar", {
      t: await manageToken(env, {
        subscriberId: id,
        version: row.manage_token_version as number,
      }),
    });

    expect(response.status).toBe(303);
    expect(await countIn("subscribers")).toBe(0);
  });

  it("refuses a manage token from before a rotation", async () => {
    const { id, manage } = await subscribedWithLink();
    const stale = manage.slice(`${MANAGE_PATH}/`.length);
    await get(await unsubscribeLinkFor(id));

    const response = await post("/resumen/borrar", { t: stale });

    // Cryptographically valid and deliberately revoked. Only the row knows which generation
    // is live, and this is the comparison that revokes it.
    expect(response.headers.get("location")).toBe("/resumen/enlace-vencido");
    expect(await countIn("subscribers")).toBe(1);
  });

  it("takes an unredeemed opt-in for the same address with it", async () => {
    const { id } = await subscribedWithLink();
    // A second signup leaves a live link that would otherwise recreate the subscriber.
    outbound.reset();
    await post("/api/resumen/suscribir", {
      email: SUBSCRIBER_EMAIL,
      species: ["cat"],
      locale: "es",
    });

    await post("/resumen/borrar", { t: await unsubscribeToken(env, id) });

    expect(await countIn("pending_opt_ins")).toBe(0);
  });

  it("is not reachable by a GET, so nothing can follow it out of an inbox", async () => {
    const response = await SELF.fetch(`${ORIGIN}/resumen/borrar`, {
      redirect: "manual",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("leaves a Do-Not-Contact entry standing where one is owed", async () => {
    const { id } = await subscribedWithLink();
    await deliverEvent("email.complained", SUBSCRIBER_EMAIL);

    await post("/resumen/borrar", { t: await unsubscribeToken(env, id) });

    expect(await countIn("subscribers")).toBe(0);
    const entries = (await rowsIn("do_not_contact")).filter(
      (row) => row.reason === "complaint",
    );
    // The residue that outlives the subscriber: it is what refuses them at the signup form.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.digest).toBe(await doNotContactDigest(env, SUBSCRIBER_EMAIL));
  });

  it("leaves nothing behind for somebody who simply asked to be forgotten", async () => {
    const { id } = await subscribedWithLink();

    await post("/resumen/borrar", { t: await unsubscribeToken(env, id) });

    // Only the canary, which is not an address at all.
    const entries = (await rowsIn("do_not_contact")).filter(
      (row) => row.reason !== "canary",
    );
    expect(entries).toHaveLength(0);
  });
});

/**
 * Resend's delivery webhook, signed the way Svix signs one:
 * `HMAC-SHA256(secret, "<id>.<timestamp>.<body>")`, base64, under the `whsec_`-prefixed key.
 */
async function deliverEvent(
  type: string,
  email: string,
  options: { bounceType?: string; signed?: boolean; timestamp?: number } = {},
): Promise<Response> {
  const body = JSON.stringify({
    type,
    data: {
      to: [email],
      ...(options.bounceType ? { bounce: { type: options.bounceType } } : {}),
    },
  });
  const id = "msg_test";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));

  const raw = env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, "");
  const decoded = atob(raw);
  const keyBytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let i = 0; i < decoded.length; i++) keyBytes[i] = decoded.charCodeAt(i);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);

  return SELF.fetch(`${ORIGIN}/api/resumen/eventos`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature":
        options.signed === false ? "v1,bm90LWEtc2lnbmF0dXJl" : `v1,${btoa(binary)}`,
    },
    redirect: "manual",
  });
}

describe("4 — retirement", () => {
  const complaints = async () =>
    (await rowsIn("do_not_contact")).filter((row) => row.reason === "complaint");

  it("refuses a delivery that is not signed by Resend", async () => {
    await subscribedWithLink();

    const response = await deliverEvent("email.complained", SUBSCRIBER_EMAIL, {
      signed: false,
    });

    // Without this, the endpoint retires any address a caller names.
    expect(response.status).toBe(401);
    expect((await subscriberRow()).retired_at).toBeNull();
  });

  it("refuses a delivery whose timestamp is outside the replay window", async () => {
    await subscribedWithLink();

    const response = await deliverEvent("email.complained", SUBSCRIBER_EMAIL, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });

    expect(response.status).toBe(401);
  });

  it("retires permanently and writes a Do-Not-Contact row on a complaint", async () => {
    await subscribedWithLink();

    expect((await deliverEvent("email.complained", SUBSCRIBER_EMAIL)).status).toBe(200);

    const row = await subscriberRow();
    expect(row.retired_at).not.toBeNull();
    expect(row.retirement_reason).toBe("complaint");
    expect(await complaints()).toHaveLength(1);
  });

  it("retires without a Do-Not-Contact row on a hard bounce", async () => {
    await subscribedWithLink();

    await deliverEvent("email.bounced", SUBSCRIBER_EMAIL, { bounceType: "hard" });

    const row = await subscriberRow();
    expect(row.retired_at).not.toBeNull();
    expect(row.retirement_reason).toBe("bounce");
    // A bounce is self-healing: opt-in completes only if the mailbox works.
    expect(await complaints()).toHaveLength(0);
  });

  it("ignores a soft bounce entirely", async () => {
    await subscribedWithLink();

    await deliverEvent("email.bounced", SUBSCRIBER_EMAIL, { bounceType: "soft" });

    // A full mailbox is not a wrong address and not a person saying stop.
    expect((await subscriberRow()).retired_at).toBeNull();
  });

  it("ignores the events the platform deliberately does not hold", async () => {
    await subscribedWithLink();

    for (const type of ["email.delivered", "email.opened", "email.clicked"]) {
      expect((await deliverEvent(type, SUBSCRIBER_EMAIL)).status).toBe(200);
    }
    expect((await subscriberRow()).retired_at).toBeNull();
  });

  it("escalates a bounce to a complaint but never the other way", async () => {
    await subscribedWithLink();

    await deliverEvent("email.bounced", SUBSCRIBER_EMAIL, { bounceType: "hard" });
    await deliverEvent("email.complained", SUBSCRIBER_EMAIL);
    expect((await subscriberRow()).retirement_reason).toBe("complaint");

    await deliverEvent("email.bounced", SUBSCRIBER_EMAIL, { bounceType: "hard" });
    expect((await subscriberRow()).retirement_reason).toBe("complaint");
  });

  it("refuses a complaining address at the signup form afterwards", async () => {
    await subscribedWithLink();
    await deliverEvent("email.complained", SUBSCRIBER_EMAIL);
    await post("/resumen/borrar", {
      t: await unsubscribeToken(env, (await rowsIn("subscribers"))[0]?.id as string),
    }).catch(() => undefined);

    outbound.reset();
    await post("/api/resumen/suscribir", {
      email: SUBSCRIBER_EMAIL,
      species: ["dog"],
      locale: "es",
    });

    // Silently, because saying so is a fact about the address — but no mail goes out.
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });

  it("writes the Do-Not-Contact entry even when the address is no longer a subscriber", async () => {
    // The entry is what survives erasure, so it must not depend on finding a row.
    expect((await deliverEvent("email.complained", "nobody@adoptante.example")).status).toBe(
      200,
    );
    expect(await complaints()).toHaveLength(1);
  });
});

describe("5 — no subscriber reaches Resend Contacts", () => {
  it("never calls the Contacts or Audiences API on any subscriber path", async () => {
    const { id, manage } = await subscribedWithLink();
    await get(manage);
    await deliverEvent("email.bounced", SUBSCRIBER_EMAIL, { bounceType: "hard" });
    await get(await unsubscribeLinkFor(id));
    await post("/resumen/borrar", { t: await unsubscribeToken(env, id) });

    /**
     * Consent is the one piece of state that must have a single owner (#62). Two systems that
     * both believe they know whether somebody is subscribed will disagree, and the digest
     * reads ours.
     */
    for (const call of outbound.callsTo("resend")) {
      expect(call.url, "no subscriber may be mirrored into Resend").not.toMatch(
        /\/(contacts|audiences)/,
      );
    }
  });
});

describe("6 — the privacy notice is the retention table", () => {
  it("renders the table with a row per retained thing", async () => {
    const html = await (await get("/privacidad")).text();
    expect(html).toContain("retention");
    expect((html.match(/retention-row/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });

  it("states the periods the code actually enforces", async () => {
    const html = await (await get("/privacidad")).text();
    // Read from the constants rather than transcribed, so these are the figures the purges
    // spend: seven days, twenty-four hours, ninety days.
    expect(html).toContain("7 días");
    expect(html).toContain("24 horas");
    expect(html).toContain("90 días");
  });

  it("admits the provider's 30-day tail and its plaintext suppression list", async () => {
    const html = await (await get("/privacidad")).text();
    // ADR 0010: the row a careful reader will check, and the one that makes the rest
    // believable.
    expect(html).toContain("30 días");
    expect(html).toContain("7");
    expect(html.toLowerCase()).toContain("resend");
    expect(html).toContain("sin cifrar");
  });

  it("answers on /privacy too, because the ticket names that path", async () => {
    const response = await get("/privacy");
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/privacidad");
  });
});

describe("7 — the manage link a subscriber is handed at opt-in", () => {
  it("is live, and opens their own page", async () => {
    await subscribe();
    const row = await subscriberRow();

    const link = await manageLinkFor(row.id as string, row.manage_token_version as number);
    const response = await get(link);

    // ADR 0010's earlier guarantee: a subscriber who never matches anything still holds a
    // working link from the moment they opt in.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(SUBSCRIBER_EMAIL);
  });

  it("is the one the redirect carried", async () => {
    outbound.reset();
    await post("/api/resumen/suscribir", {
      email: SUBSCRIBER_EMAIL,
      species: ["dog"],
      locale: "es",
    });
    const body = JSON.parse(outbound.callsTo("resend")[0]!.body!) as { text: string };
    const token = decodeURIComponent(
      body.text.match(/\/resumen\/activar\?t=([\w%-]+)/)![1]!,
    );

    const activated = await post("/resumen/activar", { t: token });
    const handed = new URL(
      activated.headers.get("location")!,
      ORIGIN,
    ).searchParams.get("t");

    expect(handed).not.toBeNull();
    const row = await subscriberRow();
    await expect(verifyManageToken(env, handed!)).resolves.toEqual({
      subscriberId: row.id,
      version: row.manage_token_version,
    });
  });
});

describe("7b — the success page renders the link it was handed", () => {
  it("shows the manage link, so the redirect is not the only place it exists", async () => {
    outbound.reset();
    await post("/api/resumen/suscribir", {
      email: SUBSCRIBER_EMAIL,
      species: ["dog"],
      locale: "es",
    });
    const body = JSON.parse(outbound.callsTo("resend")[0]!.body!) as { text: string };
    const token = decodeURIComponent(
      body.text.match(/\/resumen\/activar\?t=([\w%-]+)/)![1]!,
    );
    const activated = await post("/resumen/activar", { t: token });

    const html = await (await get(activated.headers.get("location")!)).text();

    // Carrying it in the redirect and then not rendering it would satisfy the redirect test
    // above while leaving the subscriber with nothing — ADR 0010 asks for a link they hold.
    expect(html).toContain("manage-link");
    expect(html).toContain("/resumen/mis-busquedas/");
  });
});

describe("8 — unsubscribing from the manage page", () => {
  it("stops the sending and lands on the page that carries the delete button", async () => {
    const { manage } = await subscribedWithLink();

    const response = await post(manage, {});

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(UNSUBSCRIBE_PATH);
    expect((await subscriberRow()).unsubscribed_at).not.toBeNull();
  });
});

/** Kept last: it asserts a property of the database rather than of a route. */
describe("9 — the shape of what is kept", () => {
  it("holds a MAC, a reason and a date on a Do-Not-Contact row, and no address", async () => {
    await subscribedWithLink();
    await deliverEvent("email.complained", SUBSCRIBER_EMAIL);

    const [entry] = (await rowsIn("do_not_contact")).filter(
      (row) => row.reason === "complaint",
    );

    expect(Object.keys(entry!).sort()).toEqual(["digest", "reason", "recorded_at"]);
    expect(entry!.digest).not.toContain("@");
    expect(JSON.stringify(entry)).not.toContain(SUBSCRIBER_EMAIL);
  });

  it("holds no IP on a confirmed subscriber", async () => {
    await subscribedWithLink();
    // ADR 0010 allows the subscriber model exactly one table with an IP, and it is the
    // unconfirmed row that dies at seven days.
    const columns = Object.keys(await subscriberRow());
    expect(columns.some((name) => name.includes("ip"))).toBe(false);
  });
});
