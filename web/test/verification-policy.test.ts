import { DIGEST_DAILY_BUDGET } from "@pawster/domain";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SIGN_IN_GLOBAL_DAILY_CEILING } from "../src/lib/auth/policy.ts";
import type { StoredContactPoint } from "../src/lib/shelter/store.ts";
import { decodeMethods, encodeMethods, parseDecision } from "../src/lib/verification/decision.ts";
import {
  authorises,
  mintAdminLink,
  ttlFor,
  verifyAdminLink,
} from "../src/lib/verification/link.ts";
import {
  ADMIN_MAIL_DAILY_CEILING,
  DECIDABLE_OUTCOMES,
  DECISION_LINK_TTL_MS,
  EVIDENCE_RULE,
  HAND_ONLY_OUTCOMES,
  PENDING_LIST_LINK_TTL_MS,
  canonicalCitedContactPoints,
  citedArtifactsDrifted,
  refuseAdminMail,
  requiresMethod,
  storedCitedArtifacts,
} from "../src/lib/verification/policy.ts";

/**
 * The arithmetic half of admin verification, tested without a database, a mail server or a
 * seven-day wait. Everything takes `now` as an argument — the posture `../src/lib/auth/policy.ts`
 * and `domain/` both take — so no test here fakes a clock.
 *
 * The link tests do need WebCrypto, which is why this file runs in the Worker isolate rather
 * than on plain Node: `sign()` is `crypto.subtle`, the same primitive the Session cookie uses.
 */

const AT = new Date("2026-09-08T12:00:00Z");
const at = (offsetMs: number) => new Date(AT.getTime() + offsetMs);

const SECRETS = { ADMIN_LINK_SECRET: env.ADMIN_LINK_SECRET };
const ADMIN = "admin@pawster.test";

const decisionForm = (fields: {
  outcome?: string;
  methods?: readonly string[];
  evidence?: string;
}): FormData => {
  const form = new FormData();
  if (fields.outcome !== undefined) form.set("outcome", fields.outcome);
  for (const method of fields.methods ?? []) form.append("methods", method);
  if (fields.evidence !== undefined) form.set("evidence", fields.evidence);
  return form;
};

const point = (kind: StoredContactPoint["kind"], value: string): StoredContactPoint => ({
  kind,
  value,
});

describe("how long an admin link lives", () => {
  it("is seven days for a decision and twenty-four hours for the pending list (ADR 0002)", () => {
    expect(DECISION_LINK_TTL_MS).toBe(7 * 24 * 60 * 60_000);
    expect(PENDING_LIST_LINK_TTL_MS).toBe(24 * 60 * 60_000);
  });

  /**
   * The *ordering* and not just the two figures, because the ordering is the argument: the
   * pending list "enumerates every waiting shelter and is the higher-value target" (ADR 0002),
   * and the mitigation for a higher-value bearer token is a shorter life. Two constants
   * swapped by a careless edit would still each look reasonable on its own.
   */
  it("makes the link that enumerates every shelter the shortest-lived one", () => {
    expect(PENDING_LIST_LINK_TTL_MS).toBeLessThan(DECISION_LINK_TTL_MS);
    expect(ttlFor("pending")).toBeLessThan(ttlFor("decision"));
    // A revocation token is minted at a terminal and spent seconds later, so it never gets
    // the longer window.
    expect(ttlFor("revocation")).toBeLessThanOrEqual(ttlFor("pending"));
  });
});

describe("the decision email's claim on the mail budget", () => {
  /**
   * Three files in three packages have to agree about Resend's 100 a day and none imports
   * another's number, so nothing but this notices when one moves. `auth-policy.test.ts` makes
   * the same assertion for sign-in mail; this adds the third claimant.
   */
  it("fits inside the reservation the digest holds back, beside sign-in's share", () => {
    const reservedForNonDigestMail = 100 - DIGEST_DAILY_BUDGET;
    expect(reservedForNonDigestMail).toBe(30);
    expect(SIGN_IN_GLOBAL_DAILY_CEILING + ADMIN_MAIL_DAILY_CEILING).toBeLessThan(
      reservedForNonDigestMail,
    );
  });

  it("mails up to the ceiling and refuses past it", () => {
    expect(refuseAdminMail(1)).toBeNull();
    expect(refuseAdminMail(ADMIN_MAIL_DAILY_CEILING)).toBeNull();
    expect(refuseAdminMail(ADMIN_MAIL_DAILY_CEILING + 1)).toBe("daily-ceiling");
  });
});

describe("what an emailed decision link may submit", () => {
  /**
   * The structural half of ADR 0002's "revocation is deliberately not on a signed link". The
   * decision page renders `DECIDABLE_OUTCOMES` and its parser is handed the same list, so a
   * `Revoked` that appeared in it would put a revoke button in an inbox.
   */
  it("is Verified or Refused, and never Revoked", () => {
    expect([...DECIDABLE_OUTCOMES]).toEqual(["Verified", "Refused"]);
    expect([...HAND_ONLY_OUTCOMES]).toEqual(["Revoked"]);
    expect(DECIDABLE_OUTCOMES).not.toContain("Revoked");
  });

  it("refuses a Revoked outcome posted to the decision page's parser", () => {
    const parsed = parseDecision(
      decisionForm({ outcome: "Revoked", evidence: "hand-edited form" }),
      DECIDABLE_OUTCOMES,
    );
    expect(parsed.ok).toBe(false);
  });

  it("accepts a Revoked outcome only where the off-link endpoint's set is passed", () => {
    const parsed = parseDecision(
      decisionForm({ outcome: "Revoked", evidence: "the account is gone" }),
      HAND_ONLY_OUTCOMES,
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("reading a decision form", () => {
  it("takes an outcome, its methods and the evidence", () => {
    const parsed = parseDecision(
      decisionForm({
        outcome: "Verified",
        methods: ["call", "instagram"],
        evidence: "instagram.com/refugio, posting since 2019",
      }),
      DECIDABLE_OUTCOMES,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.outcome).toBe("Verified");
    // Reordered into the vocabulary's own order, so two entries naming the same methods hold
    // the same string whatever order the checkboxes were ticked in.
    expect(parsed.value.methods).toEqual(["instagram", "call"]);
  });

  it("requires a method for Verified and not for Refused", () => {
    expect(requiresMethod("Verified")).toBe(true);
    expect(requiresMethod("Refused")).toBe(false);
    expect(requiresMethod("Revoked")).toBe(false);

    const verified = parseDecision(
      decisionForm({ outcome: "Verified", evidence: "looks fine" }),
      DECIDABLE_OUTCOMES,
    );
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.errors.some((error) => error.field === "methods")).toBe(true);
    }

    /**
     * A refusal reached by finding nothing used no method, and claiming one would be a worse
     * record than claiming none. The evidence text is where "I could not find anything" goes.
     */
    const refused = parseDecision(
      decisionForm({
        outcome: "Refused",
        evidence: "no account, no site, no mention anywhere",
      }),
      DECIDABLE_OUTCOMES,
    );
    expect(refused.ok).toBe(true);
  });

  it("requires evidence for every outcome", () => {
    for (const outcome of DECIDABLE_OUTCOMES) {
      const parsed = parseDecision(
        decisionForm({ outcome, methods: ["instagram"], evidence: "  " }),
        DECIDABLE_OUTCOMES,
      );
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.some((error) => error.field === "evidence")).toBe(true);
      }
    }
  });

  it("refuses a method the platform does not have", () => {
    const parsed = parseDecision(
      decisionForm({
        outcome: "Verified",
        methods: ["astrology"],
        evidence: "the stars said so",
      }),
      DECIDABLE_OUTCOMES,
    );
    expect(parsed.ok).toBe(false);
  });

  it("round-trips a method set through its stored form", () => {
    expect(decodeMethods(encodeMethods(["instagram", "call"]))).toEqual([
      "instagram",
      "call",
    ]);
    // History survives a vocabulary that has moved on: an unknown key is dropped rather than
    // making an old entry unreadable.
    expect(decodeMethods("instagram,seance,call")).toEqual(["instagram", "call"]);
    expect(decodeMethods("")).toEqual([]);
  });

  it("states the evidence rule in terms of artifacts and never people", () => {
    // The page renders this constant; asserting the words here is what keeps the page's
    // assertion from being a test of its own copy.
    expect(EVIDENCE_RULE).toMatch(/public artifacts/i);
    expect(EVIDENCE_RULE).toMatch(/never people/i);
  });
});

describe("minting and verifying an admin link", () => {
  it("round-trips the kind, the subject and the admin's address", async () => {
    const token = await mintAdminLink(
      SECRETS,
      { kind: "decision", shelterId: "shelter-1", admin: ADMIN },
      AT,
    );
    const claims = await verifyAdminLink(SECRETS, token, AT);
    expect(claims).not.toBeNull();
    expect(claims!.kind).toBe("decision");
    expect(claims!.shelterId).toBe("shelter-1");
    expect(claims!.admin).toBe(ADMIN);
    expect(claims!.expiresAt.getTime()).toBe(AT.getTime() + DECISION_LINK_TTL_MS);
  });

  it("stops working the instant its window closes, not a moment after", async () => {
    const token = await mintAdminLink(SECRETS, { kind: "pending", admin: ADMIN }, AT);
    expect(await verifyAdminLink(SECRETS, token, at(PENDING_LIST_LINK_TTL_MS - 1))).not.toBeNull();
    expect(await verifyAdminLink(SECRETS, token, at(PENDING_LIST_LINK_TTL_MS))).toBeNull();
  });

  it("outlives a pending link and not a week, for a decision", async () => {
    const token = await mintAdminLink(
      SECRETS,
      { kind: "decision", shelterId: "shelter-1", admin: ADMIN },
      AT,
    );
    expect(await verifyAdminLink(SECRETS, token, at(PENDING_LIST_LINK_TTL_MS))).not.toBeNull();
    /**
     * Alive on the sixth day and dead on the seventh, so both directions are pinned. Only the
     * dead direction was asserted at first, which a TTL of *any* length under a week would
     * have satisfied — including one that had accidentally become the pending list's.
     */
    expect(
      await verifyAdminLink(SECRETS, token, at(6 * 24 * 60 * 60_000)),
    ).not.toBeNull();
    expect(await verifyAdminLink(SECRETS, token, at(DECISION_LINK_TTL_MS - 1))).not.toBeNull();
    expect(await verifyAdminLink(SECRETS, token, at(DECISION_LINK_TTL_MS))).toBeNull();
  });

  it("refuses a token whose expiry has been edited", async () => {
    const token = await mintAdminLink(SECRETS, { kind: "pending", admin: ADMIN }, AT);
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/"))) as {
      x: number;
    };
    // The expiry is inside the signed message, so raising it invalidates the signature — which
    // is the difference between an expiry and a suggestion.
    const forged = `${btoa(JSON.stringify({ ...decoded, x: decoded.x + 86_400_000 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${signature}`;
    expect(await verifyAdminLink(SECRETS, forged, AT)).toBeNull();
  });

  it("refuses a token signed with another secret, and a garbage one", async () => {
    const token = await mintAdminLink(
      { ADMIN_LINK_SECRET: "not-the-platform-secret" },
      { kind: "pending", admin: ADMIN },
      AT,
    );
    expect(await verifyAdminLink(SECRETS, token, AT)).toBeNull();
    expect(await verifyAdminLink(SECRETS, "nonsense", AT)).toBeNull();
    expect(await verifyAdminLink(SECRETS, null, AT)).toBeNull();
  });

  it("will not mint a decision or revocation token that names no shelter", async () => {
    await expect(
      mintAdminLink(SECRETS, { kind: "decision", admin: ADMIN }, AT),
    ).rejects.toThrow();
    await expect(
      mintAdminLink(SECRETS, { kind: "revocation", admin: ADMIN }, AT),
    ).rejects.toThrow();
  });

  /**
   * The kind is inside the signed payload, so a link out of the admin's inbox cannot be
   * spent on a different act. This is what makes "revocation is off any link" (ADR 0002)
   * structural rather than a convention: the seven-day decision link the admin holds is not a
   * weaker form of a revocation token, it is a different capability.
   */
  it("does not let one kind of link do another kind's work", async () => {
    const decision = await verifyAdminLink(
      SECRETS,
      await mintAdminLink(
        SECRETS,
        { kind: "decision", shelterId: "shelter-1", admin: ADMIN },
        AT,
      ),
      AT,
    );
    expect(authorises(decision, "decision")).toBe(true);
    expect(authorises(decision, "revocation")).toBe(false);
    expect(authorises(decision, "pending")).toBe(false);
    /**
     * A decision token for one shelter authorises nothing about another, and that is a
     * property of *where the subject comes from* rather than of a check: every route reads
     * its shelter id out of `claims.shelterId` and from nowhere else, so there is no second
     * value for a cross-check to compare against. `authorises()` used to take one and no
     * caller ever passed it.
     */
    expect(decision!.shelterId).toBe("shelter-1");
  });
});

describe("the dead-man's switch's predicate", () => {
  const cited = storedCitedArtifacts({
    displayName: "Refugio Los Teques",
    contactPoints: [point("whatsapp", "+58 412 5550001"), point("instagram", "@refugio")],
  });

  const artifacts = (
    displayName: string,
    points: readonly StoredContactPoint[],
  ) => ({ displayName, contactPoints: points });

  const asVerified = artifacts("Refugio Los Teques", [
    point("whatsapp", "+58 412 5550001"),
    point("instagram", "@refugio"),
  ]);

  it("fires when a cited display name changes", () => {
    expect(
      citedArtifactsDrifted(
        cited,
        asVerified,
        artifacts("Refugio Los Teques A.C.", asVerified.contactPoints),
      ),
    ).toBe(true);
  });

  it("fires when a cited contact point changes, is removed or is added", () => {
    expect(
      citedArtifactsDrifted(cited, asVerified, artifacts(asVerified.displayName, [
        point("whatsapp", "+58 412 5559999"),
        point("instagram", "@refugio"),
      ])),
    ).toBe(true);
    expect(
      citedArtifactsDrifted(cited, asVerified, artifacts(asVerified.displayName, [
        point("whatsapp", "+58 412 5550001"),
      ])),
    ).toBe(true);
    /**
     * Adding one counts, and the reason is the adversarial case rather than symmetry: a new
     * channel is a channel nobody checked, surfaced beside the ones that were.
     */
    expect(
      citedArtifactsDrifted(cited, asVerified, artifacts(asVerified.displayName, [
        point("whatsapp", "+58 412 5550001"),
        point("instagram", "@refugio"),
        point("phone", "+58 212 5550002"),
      ])),
    ).toBe(true);
  });

  it("does not fire on a reorder, because the same channels were checked", () => {
    expect(
      citedArtifactsDrifted(cited, asVerified, artifacts(asVerified.displayName, [
        point("instagram", "@refugio"),
        point("whatsapp", "+58 412 5550001"),
      ])),
    ).toBe(false);
    expect(
      canonicalCitedContactPoints([
        point("instagram", "@refugio"),
        point("whatsapp", "+58 412 5550001"),
      ]),
    ).toBe(
      canonicalCitedContactPoints([
        point("whatsapp", "+58 412 5550001"),
        point("instagram", "@refugio"),
      ]),
    );
  });

  it("does not fire on a save that changed nothing cited", () => {
    expect(citedArtifactsDrifted(cited, asVerified, asVerified)).toBe(false);
  });

  /**
   * The *exactly once* half of the ticket's criterion, and the reason the predicate is a
   * transition rather than a comparison: a shelter that has already drifted is not a shelter
   * the admin needs telling about twice, and asking only "does it still match" would make a
   * verified shelter an unbounded mail tap.
   */
  it("fires on the edit that breaks the match and not on the ones after it", () => {
    const drifted = artifacts("Refugio Nuevo", asVerified.contactPoints);
    expect(citedArtifactsDrifted(cited, asVerified, drifted)).toBe(true);
    expect(
      citedArtifactsDrifted(cited, drifted, artifacts("Refugio Nuevo II", drifted.contactPoints)),
    ).toBe(false);
  });

  it("fires again once the shelter has put the cited values back and changed them anew", () => {
    const drifted = artifacts("Refugio Nuevo", asVerified.contactPoints);
    expect(citedArtifactsDrifted(cited, drifted, asVerified)).toBe(false);
    expect(citedArtifactsDrifted(cited, asVerified, drifted)).toBe(true);
  });
});
