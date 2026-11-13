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
import { regenerateForAct } from "../listing/regenerate.ts";
import type { VerificationMailEnv } from "./mail.ts";
import { sendCitedArtifactsChangedEmail, sendOutcomeEmail } from "./mail.ts";
import { appendVerification, readLatestVerification } from "./store.ts";

/**
 * `MEDIA` joins this because a decision changes what the public listing shows: standing is a
 * clause of the listing rule, so **verifying a shelter lists its entire roster at once and
 * revoking it delists the same roster** — and the listing an adopter reads is a file in R2,
 * not a query. ADR 0018 names verification as one of the acts that regenerate the index.
 */
export type VerificationEnv = VerificationMailEnv &
  AdminLinkSecrets & { readonly MEDIA: R2Bucket };

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
      /**
       * Whether the public listing was rewritten to match the decision just made.
       *
       * Reported for the same reason `shelterMailed` is, and it matters most in the direction
       * that is hardest to notice: a revocation whose index write is lost leaves a revoked
       * shelter's animals on adopters' cards, and the shelter will make no further act to heal
       * it — so the nightly regeneration is the only thing that will, which bounds it at one
       * run rather than at nothing. An admin who can see that is an admin who can wait
       * knowingly or re-post; an admin who cannot is being told the roster is gone when it is
       * not.
       */
      readonly listingUpdated: boolean;
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

  /**
   * The listing consequence of the standing change, once, after the entry that caused it.
   *
   * Ahead of the mail rather than after it, and the ordering is a judgement about which of the
   * two an adopter can see: a revoked shelter's animals sitting on the public listing is the
   * platform lying to adopters, while a notification arriving a second later is nothing. The
   * mail below is allowed to be slow; this is not allowed to queue behind it.
   *
   * It is one regeneration for a whole roster. Per-animal regeneration would make this
   * quadratic — a forty-animal roster would be forty reads of the listable set and forty puts,
   * thirty-nine of them publishing a half-verified shelter to adopters (ADR 0018).
   */
  const listingUpdated =
    (await regenerateForAct({ db, media: env.MEDIA, now })) !== null;

  if (request.outcome === "Verified") {
    return { recorded: true, shelterMailed: null, listingUpdated };
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

  return { recorded: true, shelterMailed, listingUpdated };
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
