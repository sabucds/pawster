import { createDb, shelters, verifications } from "@pawster/db";
import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { mintAdminLink } from "../src/lib/verification/link.ts";
import {
  DECISION_LINK_TTL_MS,
  PENDING_LIST_LINK_TTL_MS,
} from "../src/lib/verification/policy.ts";
import {
  clearShelterTables,
  cookieFrom,
  get,
  ORIGIN,
  post,
  register,
  REGISTRATION,
  signIn,
} from "./support/shelter.ts";

/**
 * The admin surface, through the Worker's own front door: a real `workerd` isolate, a real
 * local D1 with the real migrations applied, and every email leaving through the single
 * outbound interceptor (`docs/testing-seams.md`).
 *
 * What is asserted here rather than in `verification-policy.test.ts` is everything that is
 * only true of the whole path: that a `GET` writes nothing, that a decision appends rather
 * than replaces, that a session cookie buys nothing, and that the three emails are the three
 * emails.
 */

const ADMIN = env.ADMIN_EMAIL;
const SECRETS = { ADMIN_LINK_SECRET: env.ADMIN_LINK_SECRET };

const db = () => createDb(env.DB);

async function shelterIdFor(accountEmail = REGISTRATION.accountEmail): Promise<string> {
  const [row] = await db()
    .select({ id: shelters.id })
    .from(shelters)
    .where(eq(shelters.accountEmail, accountEmail));
  return row!.id;
}

async function entriesFor(shelterId: string) {
  return await db()
    .select()
    .from(verifications)
    .where(eq(verifications.shelterId, shelterId));
}

/** A decision link the way the admin's inbox holds one. */
async function decisionLink(shelterId: string, now = new Date()): Promise<string> {
  const token = await mintAdminLink(
    SECRETS,
    { kind: "decision", shelterId, admin: ADMIN },
    now,
  );
  return `/admin/decide?t=${encodeURIComponent(token)}`;
}

async function pendingLink(now = new Date()): Promise<string> {
  const token = await mintAdminLink(SECRETS, { kind: "pending", admin: ADMIN }, now);
  return `/admin/pending?t=${encodeURIComponent(token)}`;
}

/** The token out of a link, for the hidden input a decision `POST` carries. */
const tokenOf = (link: string) =>
  decodeURIComponent(new URL(link, ORIGIN).searchParams.get("t")!);

/** The one email in the log, parsed. */
function onlyEmail() {
  const calls = outbound.callsTo("resend");
  expect(calls).toHaveLength(1);
  return JSON.parse(calls[0]!.body!) as {
    from: string;
    to: string[];
    subject: string;
    text: string;
    reply_to?: string;
  };
}

/**
 * Only the tables. The interceptor is installed once by `test/setup.ts` and reset there per
 * test, and it stays installed for the whole run on purpose — "the point is that nothing can
 * leave without being seen, and a suite that installs it per-test has a window in which
 * something can". A `restore()` here would take it out from under every later file.
 */
beforeEach(clearShelterTables);

describe("a registration asks the admin for a decision", () => {
  it("sends exactly one email, to the admin, carrying both links", async () => {
    const response = await register();
    expect(response.status).toBe(303);

    const mail = onlyEmail();
    expect(mail.to).toEqual([ADMIN]);
    expect(mail.from).toBe(env.VERIFICATION_FROM_ADDRESS);
    expect(mail.subject).toContain(REGISTRATION.displayName);
    // The decision link and the pending list, and the pending list says it dies first.
    expect(mail.text).toContain("/admin/decide?t=");
    expect(mail.text).toContain("/admin/pending?t=");
    // The shelter's credential is not in a mail whose security model is one inbox.
    expect(mail.text).not.toContain(REGISTRATION.accountEmail);
  });

  it("writes no verification row — pending is the absence of an entry (ADR 0003)", async () => {
    await register();
    expect(await entriesFor(await shelterIdFor())).toHaveLength(0);
  });

  it("sends nothing when the address is already registered", async () => {
    await register();
    outbound.reset();
    // The duplicate answers with the success page and writes no second shelter, so there is
    // no second decision to ask for.
    const response = await register();
    expect(response.status).toBe(303);
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });

  it("registers the shelter even when Resend refuses the decision email", async () => {
    outbound.on("resend", () => new Response("nope", { status: 500 }));
    const response = await register();
    expect(response.status).toBe(303);
    // The row is what matters: the shelter was promised an answer in three days and the
    // pending list still holds it, so a failed notification costs the queue nothing (ADR 0002).
    expect(await shelterIdFor()).toBeTruthy();
  });
});

describe("the decision link", () => {
  it("renders the shelter's live state and mutates nothing on GET", async () => {
    await register();
    const shelterId = await shelterIdFor();
    outbound.reset();

    const response = await get(await decisionLink(shelterId));
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain(REGISTRATION.displayName);
    expect(html).toContain(REGISTRATION.contactValue[0]);
    // ADR 0008: a mail scanner fetching this URL must not verify anybody.
    expect(await entriesFor(shelterId)).toHaveLength(0);
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });

  it("states the evidence rule where the admin is typing", async () => {
    await register();
    const html = await (await get(await decisionLink(await shelterIdFor()))).text();
    expect(html).toMatch(/public artifacts/i);
    expect(html).toMatch(/never people/i);
  });

  it("never shows the shelter's account email", async () => {
    await register();
    const html = await (await get(await decisionLink(await shelterIdFor()))).text();
    expect(html).not.toContain(REGISTRATION.accountEmail);
  });

  it("stops working after seven days", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const stale = new Date(Date.now() - DECISION_LINK_TTL_MS - 1);
    const response = await get(await decisionLink(shelterId, stale));
    expect(response.status).toBe(404);
  });

  it("is refused when the token is for another kind of act", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const token = await mintAdminLink(
      SECRETS,
      { kind: "revocation", shelterId, admin: ADMIN },
      new Date(),
    );
    const response = await get(`/admin/decide?t=${encodeURIComponent(token)}`);
    expect(response.status).toBe(404);
  });
});

describe("deciding", () => {
  it("verifies on a POST, appending one entry, and emails the shelter nothing", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const link = await decisionLink(shelterId);
    outbound.reset();

    const response = await post("/admin/decide", {
      t: tokenOf(link),
      outcome: "Verified",
      methods: ["instagram", "call"],
      evidence: "instagram.com/refugiolosteques, posting since 2019; spoke to them",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("recorded=Verified");

    const entries = await entriesFor(shelterId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("Verified");
    expect(entries[0]!.methods).toBe("instagram,call");
    // `decidedBy` is the address the link was sent to, and not a foreign key (ADR 0002).
    expect(entries[0]!.decidedBy).toBe(ADMIN);
    // The snapshot the dead-man's switch will compare against (ADR 0019).
    expect(entries[0]!.citedDisplayName).toBe(REGISTRATION.displayName);
    expect(entries[0]!.citedContactPoints).toContain(REGISTRATION.contactValue[0]);

    expect(outbound.callsTo("resend")).toHaveLength(0);
  });

  it("refuses on a POST and emails the shelter a replyable email", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const link = await decisionLink(shelterId);
    outbound.reset();

    const response = await post("/admin/decide", {
      t: tokenOf(link),
      outcome: "Refused",
      evidence: "no account, no site, no mention anywhere",
    });
    expect(response.status).toBe(303);

    const mail = onlyEmail();
    expect(mail.to).toEqual([REGISTRATION.accountEmail]);
    // The half of a refusal issue #45 cares about: a real address that reaches a person.
    expect(mail.reply_to).toBe(ADMIN);
    expect(mail.text).toMatch(/respóndele a este correo/i);

    const entries = await entriesFor(shelterId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe("Refused");
  });

  it("appends a second decision and leaves the first untouched", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const token = tokenOf(await decisionLink(shelterId));

    await post("/admin/decide", {
      t: token,
      outcome: "Refused",
      evidence: "nothing public at all",
    });
    const [first] = await entriesFor(shelterId);

    await post("/admin/decide", {
      t: token,
      outcome: "Verified",
      methods: ["registry"],
      evidence: "they sent the registry entry; it checks out",
    });

    const entries = await entriesFor(shelterId);
    expect(entries).toHaveLength(2);
    // Byte for byte the row that was there before, which is the whole of "append-only".
    expect(entries[0]).toEqual(first);
    // Current standing is the latest entry, and the sequence is what "latest" means.
    expect(entries[1]!.id).toBeGreaterThan(entries[0]!.id);
    expect(entries[1]!.outcome).toBe("Verified");
  });

  it("refuses a decision with no evidence, and writes nothing", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const response = await post("/admin/decide", {
      t: tokenOf(await decisionLink(shelterId)),
      outcome: "Verified",
      methods: ["instagram"],
      evidence: "   ",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data-testid=\"errors\"");
    expect(await entriesFor(shelterId)).toHaveLength(0);
  });

  it("cannot revoke, whatever the form says (ADR 0002)", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const response = await post("/admin/decide", {
      t: tokenOf(await decisionLink(shelterId)),
      outcome: "Revoked",
      evidence: "trying to revoke from the emailed link",
    });
    // Refused by the parser, so no entry of any kind was written.
    expect(response.status).toBe(200);
    expect(await entriesFor(shelterId)).toHaveLength(0);
  });
});

describe("a verified shelter's animals, and a revoked one's", () => {
  it("flips the shelter's own visibility notice through the listing rule", async () => {
    const { cookie } = await signIn();
    const shelterId = await shelterIdFor();

    const before = await (await get("/refugios/panel", cookie)).text();
    expect(before).toContain("Todavía no se ve nada de lo tuyo");

    await post("/admin/decide", {
      t: tokenOf(await decisionLink(shelterId)),
      outcome: "Verified",
      methods: ["instagram"],
      evidence: "instagram.com/refugio, active",
    });

    const after = await (await get("/refugios/panel", cookie)).text();
    expect(after).toContain("Tu refugio está verificado");
  });

  /**
   * The ticket's "a `Revoked` latest entry delists the shelter's animals through the listing
   * rule, with no new state anywhere". The revocation is written the only way it can be —
   * through the off-link endpoint with a hand-minted token — and the delisting is read off the
   * page that asks `isListed()`.
   */
  it("delists again on a revocation, with no state but the entry", async () => {
    const { cookie } = await signIn();
    const shelterId = await shelterIdFor();

    await post("/admin/decide", {
      t: tokenOf(await decisionLink(shelterId)),
      outcome: "Verified",
      methods: ["instagram"],
      evidence: "instagram.com/refugio, active",
    });
    outbound.reset();

    const token = await mintAdminLink(
      SECRETS,
      { kind: "revocation", shelterId, admin: ADMIN },
      new Date(),
    );
    const response = await post("/api/admin/revoke", {
      t: token,
      outcome: "Revoked",
      evidence: "the account was sold; the number answers as a different organisation",
    });
    expect(response.status).toBe(200);

    // A real, replyable email to the shelter — the same requirement a refusal has.
    const mail = onlyEmail();
    expect(mail.to).toEqual([REGISTRATION.accountEmail]);
    expect(mail.reply_to).toBe(ADMIN);

    const after = await (await get("/refugios/panel", cookie)).text();
    expect(after).toContain("Todavía no se ve nada de lo tuyo");

    // Three entries would mean something wrote a state change beside the log; there are two.
    const entries = await entriesFor(shelterId);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.outcome).toBe("Revoked");
  });

  it("refuses a revocation presented with a decision link", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const response = await post("/api/admin/revoke", {
      t: tokenOf(await decisionLink(shelterId)),
      outcome: "Revoked",
      evidence: "trying the emailed link against the revoke endpoint",
    });
    expect(response.status).toBe(404);
    expect(await entriesFor(shelterId)).toHaveLength(0);
  });

  it("has no GET at all on the revoke endpoint", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const token = await mintAdminLink(
      SECRETS,
      { kind: "revocation", shelterId, admin: ADMIN },
      new Date(),
    );
    const response = await get(`/api/admin/revoke?t=${encodeURIComponent(token)}`);
    expect(response.status).toBeGreaterThanOrEqual(404);
    expect(await entriesFor(shelterId)).toHaveLength(0);
  });
});

describe("the pending list", () => {
  it("lists every shelter awaiting a first decision, and drops the decided ones", async () => {
    await register({ accountEmail: "uno@refugio.example", displayName: "Refugio Uno" });
    await register({ accountEmail: "dos@refugio.example", displayName: "Refugio Dos" });
    const decided = await shelterIdFor("uno@refugio.example");

    const before = await (await get(await pendingLink())).text();
    expect(before).toContain("Refugio Uno");
    expect(before).toContain("Refugio Dos");

    await post("/admin/decide", {
      t: tokenOf(await decisionLink(decided)),
      outcome: "Refused",
      evidence: "nothing public",
    });

    const after = await (await get(await pendingLink())).text();
    // A refused shelter has an entry, so the judgement was made: this is a queue of decisions
    // owed, not a list of shelters in trouble.
    expect(after).not.toContain("Refugio Uno");
    expect(after).toContain("Refugio Dos");
  });

  it("stops working after twenty-four hours", async () => {
    await register();
    const stale = new Date(Date.now() - PENDING_LIST_LINK_TTL_MS - 1);
    expect((await get(await pendingLink(stale))).status).toBe(404);
  });

  it("mutates nothing", async () => {
    await register();
    const shelterId = await shelterIdFor();
    outbound.reset();
    await get(await pendingLink());
    expect(await entriesFor(shelterId)).toHaveLength(0);
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });
});

describe("no admin route takes a session", () => {
  it("refuses a signed-in shelter that presents no token", async () => {
    const { cookie } = await signIn();
    expect((await get("/admin/pending", cookie)).status).toBe(404);
    expect((await get("/admin/decide", cookie)).status).toBe(404);
  });

  it("sets no cookie of its own on any admin response", async () => {
    await register();
    const shelterId = await shelterIdFor();
    const decision = await get(await decisionLink(shelterId));
    const pending = await get(await pendingLink());
    for (const response of [decision, pending]) {
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(cookieFrom(response, "pawster_session")).toBeNull();
    }
  });

  it("holds no admin row in any table", async () => {
    /**
     * ADR 0002 gave admins no accounts, and the ticket asks for "no admin row [...] in any
     * table". Asserted against `sqlite_master` rather than against a list of tables kept in a
     * test, so a future migration that adds an `admins` table fails here rather than passing
     * unnoticed.
     */
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();
    const names = results.map((row) => row.name);
    expect(names.filter((name) => /admin|user|moderator/i.test(name))).toEqual([]);
  });
});

describe("the dead-man's switch", () => {
  const profileFields = {
    displayName: REGISTRATION.displayName,
    baseRegion: REGISTRATION.baseRegion,
    contactKind: ["whatsapp"],
    contactValue: [REGISTRATION.contactValue[0]!],
    contactPosition: ["0"],
  };

  async function verifiedShelter() {
    const session = await signIn();
    const shelterId = await shelterIdFor();
    await post("/admin/decide", {
      t: tokenOf(await decisionLink(shelterId)),
      outcome: "Verified",
      methods: ["instagram"],
      evidence: "instagram.com/refugio, active since 2019",
    });
    outbound.reset();
    return { ...session, shelterId };
  }

  it("emails the admin exactly once when a cited display name changes", async () => {
    const { cookie } = await verifiedShelter();

    const response = await post(
      "/refugios/perfil",
      { ...profileFields, displayName: "Refugio Los Teques A.C." },
      { cookie },
    );
    expect(response.status).toBe(303);

    const mail = onlyEmail();
    expect(mail.to).toEqual([ADMIN]);
    expect(mail.subject).toContain("changed what you verified");
    expect(mail.text).toContain("Refugio Los Teques A.C.");

    // A second edit is more of the same drift, and does not mail again.
    outbound.reset();
    await post(
      "/refugios/perfil",
      { ...profileFields, displayName: "Refugio Los Teques AC" },
      { cookie },
    );
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });

  it("emails the admin when a cited contact point changes", async () => {
    const { cookie } = await verifiedShelter();
    await post(
      "/refugios/perfil",
      { ...profileFields, contactValue: ["+58 412 5559999"] },
      { cookie },
    );
    expect(onlyEmail().to).toEqual([ADMIN]);
  });

  it("says nothing when the save changed nothing cited", async () => {
    const { cookie } = await verifiedShelter();
    await post("/refugios/perfil", { ...profileFields, baseRegion: "Aragua" }, { cookie });
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });

  it("says nothing for a shelter that is not verified", async () => {
    const { cookie } = await signIn();
    // Signing in registered a shelter and asked for a code, which is two emails that have
    // nothing to do with the switch. Cleared, so the zero below is about the profile save.
    outbound.reset();
    await post(
      "/refugios/perfil",
      { ...profileFields, displayName: "Otro Nombre" },
      { cookie },
    );
    expect(outbound.callsTo("resend")).toHaveLength(0);
  });
});
