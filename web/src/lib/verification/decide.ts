/**
 * The two acts of admin verification: recording a decision, and noticing that a verified
 * shelter has changed what was cited about it.
 *
 * This is the only place either happens. That matters most for the first: **every outcome is
 * written by one function**, so the append-only entry, the snapshot the dead-man's switch
 * will later compare against, and the shelter's replyable email cannot come apart. The
 * alternative — a route that inserts a row and then remembers to send mail — is how a
 * revocation ends up delisting a shelter's animals with nothing in anyone's inbox to explain
 * it.
 *
 * The three outcomes reach this from two different places, and the split is the security
 * boundary rather than a convenience:
 *
 * - `Verified` and `Refused` come from the decision page, behind an emailed link.
 * - `Revoked` comes only from `POST /api/admin/revoke`, which accepts a `revocation` token
 *   and nothing else — a token no email has ever carried, mintable only at a terminal
 *   holding the platform's link-signing secret. ADR 0002: "revocation is deliberately not on
 *   a signed link. It is the rare adversarial action and is done by hand."
 *
 * Neither act builds a Drizzle client; both take one.
 */

import type { Database } from "@pawster/db";
import type { VerificationOutcome } from "@pawster/domain";
import type { ShelterProfile } from "../shelter/store.ts";
import { readShelterProfile } from "../shelter/store.ts";
import type { CitedArtifacts, VerificationMethod } from "./policy.ts";
import { citedArtifactsDrifted, parseCitedContactPoints } from "./policy.ts";
import type { AdminLinkSecrets } from "./link.ts";
import { ADMIN_DECISION_PATH, adminLinkUrl, mintAdminLink } from "./link.ts";
import type { VerificationMailEnv } from "./mail.ts";
import { sendCitedArtifactsChangedEmail, sendOutcomeEmail } from "./mail.ts";
import { appendVerification, readLatestVerification } from "./store.ts";

export type VerificationEnv = VerificationMailEnv & AdminLinkSecrets;

export interface DecisionRequest {
  readonly shelterId: string;
  readonly outcome: VerificationOutcome;
  readonly methods: readonly VerificationMethod[];
  readonly evidence: string;
  /** The address the link was sent to, out of the token's payload. ADR 0002. */
  readonly decidedBy: string;
}

export type DecisionResult =
  /** The shelter this names is not there. Nothing was written. */
  | { readonly recorded: false }
  | {
      readonly recorded: true;
      /**
       * Whether the shelter's mail actually went out, and `null` where the outcome sends
       * none (`Verified`).
       *
       * Reported rather than thrown, because the entry is already written by the time mail is
       * attempted and an append-only log does not roll back. The decision page shows this, so
       * an admin who refused a shelter knows whether the shelter was told — which is the one
       * thing they would otherwise have to guess at.
       */
      readonly shelterMailed: boolean | null;
    };

/**
 * Record one judgement and tell the shelter if the judgement is against it.
 *
 * The order is: read the shelter, append the entry, then mail. Appending first is deliberate
 * — the decision is the durable act and the mail is a notification of it, so a mail failure
 * must not cost the admin the entry they just made. The reverse order would leave a shelter
 * emailed about a refusal that is not in the log.
 *
 * **The snapshot is taken here, from live state, not from the form.** The entry attests to
 * the display name and contact points as they stood at the moment of the judgement, which is
 * what the decision page had just rendered; taking them from hidden inputs would let the
 * page's own staleness — or a hand-edited form — decide what the admin is recorded as having
 * checked.
 */
export async function decideVerification(
  db: Database,
  env: VerificationEnv,
  request: DecisionRequest,
  now: Date,
): Promise<DecisionResult> {
  const shelter = await readShelterProfile(db, request.shelterId);
  if (!shelter) return { recorded: false };

  await appendVerification(
    db,
    {
      shelterId: request.shelterId,
      outcome: request.outcome,
      methods: request.methods,
      evidence: request.evidence,
      decidedBy: request.decidedBy,
      cited: citedOf(shelter),
    },
    now,
  );

  if (request.outcome === "Verified") {
    return { recorded: true, shelterMailed: null };
  }

  /**
   * A failed send is swallowed and reported, never thrown.
   *
   * Resend refusing is not a reason to fail the request: the entry stands, the shelter's
   * animals are already delisted by the listing rule, and re-posting the form would append a
   * second entry rather than retry the mail. What the admin gets instead is a page that says
   * the mail did not go out, which is actionable — they can write to the shelter themselves,
   * which is what the reply-to address on that mail was pointing at anyway.
   */
  let shelterMailed = true;
  try {
    await sendOutcomeEmail(env, {
      to: shelter.accountEmail,
      displayName: shelter.displayName,
      outcome: request.outcome,
    });
  } catch {
    shelterMailed = false;
  }

  return { recorded: true, shelterMailed };
}

/**
 * The dead-man's switch, called after a shelter saves its profile.
 *
 * Returns whether the admin was emailed, which is what the tests assert on — "editing a
 * cited display name or contact point emails the admin exactly once" is a property of this
 * function's trigger, and the trigger is a pure predicate (`citedArtifactsDrifted()`) so the
 * *exactly once* half is table-tested rather than inferred from a mail log.
 *
 * Three ways this does nothing, and each is a real case rather than a guard:
 *
 * - **The shelter has no entry, or its latest is not `Verified`.** Nothing of a pending or
 *   refused shelter's is visible, so there is no stale check to warn about — the same reason
 *   ADR 0008 never nudges those shelters.
 * - **The edit did not touch a cited artifact.** A base region or an account email change is
 *   not a change to the public presence that was checked.
 * - **The shelter had already drifted.** See `citedArtifactsDrifted()`: this fires on the
 *   transition, so a shelter that keeps editing after the first warning does not keep mailing
 *   the admin.
 *
 * Mail failures are swallowed here too, and the reason is sharper than above: this runs
 * *after* a shelter's profile save has succeeded, and a shelter must never be shown a failed
 * save because the platform could not tell its admin about it.
 */
export async function noteProfileEdit(
  db: Database,
  env: VerificationEnv,
  shelterId: string,
  before: CitedArtifacts,
  after: ShelterProfile,
  now: Date,
): Promise<boolean> {
  const latest = await readLatestVerification(db, shelterId);
  if (!latest || latest.outcome !== "Verified") return false;

  if (!citedArtifactsDrifted(latest, before, citedOf(after))) return false;

  try {
    const token = await mintAdminLink(
      env,
      { kind: "decision", shelterId, admin: env.ADMIN_EMAIL },
      now,
    );
    await sendCitedArtifactsChangedEmail(env, {
      shelter: after,
      citedDisplayName: latest.citedDisplayName,
      citedContactPoints: parseCitedContactPoints(latest.citedContactPoints),
      decisionUrl: adminLinkUrl(env.SITE_ORIGIN, ADMIN_DECISION_PATH, token),
    });
  } catch {
    return false;
  }

  return true;
}

/** The two facts an entry attests to, out of whatever carries them. */
export function citedOf(shelter: {
  readonly displayName: string;
  readonly contactPoints: CitedArtifacts["contactPoints"];
}): CitedArtifacts {
  return {
    displayName: shelter.displayName,
    contactPoints: shelter.contactPoints,
  };
}
