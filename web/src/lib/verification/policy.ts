/**
 * The numbers, the vocabulary and the verdicts of admin verification, with no I/O and no
 * clock of its own.
 *
 * The same posture `../auth/policy.ts` takes, and it lives in `web/` for the same reason:
 * `domain/` is "the pure rules three consumers share — the prerender, the browser island
 * and the digest matcher", and none of those three verifies a shelter. The purity is worth
 * having anyway, because it is what lets the two rules that actually decide something here
 * — the link lifetimes and the dead-man's switch — be table tests rather than integration
 * tests with a mail server and a seven-day wait in them.
 *
 * The one piece of verification vocabulary that is *not* here is
 * `domain/`'s `VerificationOutcome`, because `isListed()` reads it: the listing rule is the
 * whole consequence of a decision, so the three words belong to the package all three
 * consumers already import.
 */

import type { VerificationOutcome } from "@pawster/domain";
import type { ContactPointKind } from "@pawster/db";
import type { StoredContactPoint } from "../shelter/store.ts";
import { CONTACT_POINT_KINDS } from "../shelter/fields.ts";
import { MAIL_BUDGET_WINDOW_MS } from "../auth/policy.ts";

/**
 * Seven days for a decision link ([ADR 0002](../../../../docs/adr/0002-no-admin-accounts.md)).
 *
 * The admin's inbox is the admin credential, which ADR 0002 accepts at this stake level and
 * mitigates with exactly this: a link that stops working. Seven days is long enough that a
 * registration arriving on a Friday survives a week away and short enough that a link
 * sitting in an archived thread a month later is worth nothing.
 */
export const DECISION_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Twenty-four hours for the pending-list link — the shortest-lived link on the platform,
 * and shorter than a decision link *on purpose* rather than by coincidence.
 *
 * A decision link authorises one shelter. The pending list **enumerates every waiting
 * shelter**, so it is the higher-value target of the two (ADR 0002 says so in those words),
 * and the mitigation for a higher-value bearer token is a shorter life. Anything that
 * reversed this ordering would be a bug that no test could see, which is why
 * `verification-policy.test.ts` asserts the ordering itself and not just the two figures.
 */
export const PENDING_LIST_LINK_TTL_MS = 24 * 60 * 60_000;

/**
 * How many decision emails the platform will send in a trailing day.
 *
 * This exists because registration is unauthenticated and unbounded — `registro/index.astro`
 * says so in its own module comment — and issue #53 hands that route an *email*. Without a
 * ceiling, a script posting valid registrations spends Resend's 100 a day, and the first
 * thing that starves is shelter sign-in mail: a shelter that cannot get a code cannot
 * publish at all.
 *
 * Five, against an expected rate nearer one a week: `domain/`'s `DIGEST_DAILY_BUDGET` holds
 * 30 of the 100 back for non-digest mail, sign-in's global ceiling claims 20 of those, and
 * this claims 5 of the remaining 10 — leaving room for the two claimants that have not
 * landed yet, opt-in mail (#61) and confirmation nudges (#60).
 * `verification-policy.test.ts` asserts that arithmetic across the three files, none of
 * which imports another's number.
 *
 * **Refusing to send is safe here, and that is the whole reason a ceiling is acceptable at
 * all.** ADR 0002 already declines to guard the verification queue with a cron: "a shelter
 * is told it will hear back within 3 days and invited to reply if it doesn't, making the
 * shelter an external dead-man's switch". A registration whose decision email was refused is
 * still in the pending list, and the shelter is still expecting an answer — so the queue
 * loses a notification and never loses an entry.
 */
export const ADMIN_MAIL_DAILY_CEILING = 5;

/**
 * The window the ceiling is counted over, borrowed from the sign-in ledger rather than
 * declared again.
 *
 * The same trailing 24 hours, for the reason `mailBudgetWindowStart()` gives: a calendar day
 * has a boundary an attacker can sit on, and it resets at 20:00 in Venezuela. Two constants
 * spelling the same window would be two things to keep in step for no gain.
 */
export const ADMIN_MAIL_WINDOW_MS = MAIL_BUDGET_WINDOW_MS;

export function adminMailWindowStart(now: Date): Date {
  return new Date(now.getTime() - ADMIN_MAIL_WINDOW_MS);
}

/** Why this registration may not spend a decision email, or `null` when it may. */
export type AdminMailRefusal = "daily-ceiling";

/**
 * Whether the platform will mail the admin about a registration.
 *
 * The count is **registrations in the window**, not decision emails sent, and the identity
 * between the two is the design: exactly one decision email is sent per shelter created, so
 * `shelters.created_at` already *is* the ledger. That is the posture `signInRequests` and
 * `transformationSpends` both take — "every limit is then a query over the same rows, with
 * no denormalised total that can disagree with the history it summarises" — reached here
 * without a table of its own.
 *
 * The count includes the registration being decided about, because the row is written before
 * the mail is attempted. So the ceiling is inclusive: the fifth registration of the day is
 * mailed and the sixth is not.
 */
export function refuseAdminMail(
  registrationsInWindow: number,
): AdminMailRefusal | null {
  return registrationsInWindow > ADMIN_MAIL_DAILY_CEILING ? "daily-ceiling" : null;
}

/**
 * The ways an admin can check a shelter, as a closed list.
 *
 * A fixed vocabulary rather than free text, because ADR 0003 records "the methods used"
 * *beside* the evidence: the evidence is the artifact, the method is how it was reached, and
 * a method typed differently every time is a column nobody can read across entries. The
 * evidence textarea is where anything not on this list goes.
 *
 * Deliberately short, and each entry is a check that costs the admin one action against a
 * presence a Venezuelan shelter plausibly already has (`CONTEXT.md`: a shelter is verified
 * "against the public presence it already has"). What is **not** here is any method that
 * would need the shelter to send a document: ADR-level scope rules out storing legal
 * paperwork, so there is no `documents` method for a file the platform will not hold.
 */
export const VERIFICATION_METHODS = [
  "instagram",
  "website",
  "press",
  "registry",
  "call",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/**
 * What each method is called on the decision page, in English.
 *
 * English because the admin surface is a maintainer's tool and not a user-facing one:
 * `CONTEXT.md`'s *User-facing Spanish* table governs what adopters and shelters read, and
 * the Platform Admin is "a role in the domain, not in the auth system" — the same person who
 * reads this repository. The mail this page causes to be sent to a *shelter* is es-VE, in
 * `mail.ts`, which is where the boundary between the two audiences actually falls.
 */
export const VERIFICATION_METHOD_LABELS: Record<VerificationMethod, string> = {
  instagram: "Instagram account with a history of posts",
  website: "Own website or a page on another organisation's site",
  press: "Mention in local press or by another organisation",
  registry: "Public registry or charity record",
  call: "Spoke to them by phone or WhatsApp",
};

export function isVerificationMethod(value: string): value is VerificationMethod {
  return (VERIFICATION_METHODS as readonly string[]).includes(value);
}

/**
 * The outcomes an emailed decision link may submit, and **`Revoked` is not one of them.**
 *
 * ADR 0002: "Revocation is deliberately not on a signed link. It is the rare adversarial
 * action and is done by hand." This constant is that sentence made structural — the decision
 * page passes it to `parseDecision()`, so the page cannot produce a revocation however its
 * form is hand-edited, and the refusal happens in the parser rather than in a `if` somewhere
 * in a route that a later edit could drop.
 */
export const DECIDABLE_OUTCOMES = ["Verified", "Refused"] as const satisfies
  readonly VerificationOutcome[];

/**
 * The outcomes reachable only off-link, by hand, by a maintainer at a terminal holding the
 * platform's own link-signing secret.
 *
 * Named apart from {@link DECIDABLE_OUTCOMES} rather than left as "everything else", so that
 * the split is a list one can read rather than a subtraction one has to perform.
 */
export const HAND_ONLY_OUTCOMES = ["Revoked"] as const satisfies
  readonly VerificationOutcome[];

/**
 * Whether an outcome needs at least one method named.
 *
 * `Verified` does: a verification with no method recorded is the flag flip ADR 0002 rejected
 * — "verification is not a flag flip" — and an entry that cannot say how it was reached is
 * the thing ADR 0003's log exists to prevent.
 *
 * `Refused` and `Revoked` do not, and that asymmetry is honest rather than lax. A refusal is
 * frequently reached by finding *nothing*: there was no Instagram account, no site and no
 * mention, so no method was used and claiming one would be a worse record than claiming
 * none. The evidence text is required either way, which is where "I could not find anything"
 * gets written down.
 */
export function requiresMethod(outcome: VerificationOutcome): boolean {
  return outcome === "Verified";
}

/**
 * Bounds on the evidence text: long enough for a paragraph with three URLs in it, short
 * enough that the column is not free storage on an endpoint reachable with a bearer link.
 */
export const MAX_EVIDENCE = 2000;
export const MIN_EVIDENCE = 3;

/**
 * The rule the decision page states beside the textarea, and the reason it is a string in a
 * policy module rather than prose in a template.
 *
 * It is the ticket's acceptance criterion — "the page states the
 * evidence-describes-artifacts-never-people rule where the admin will read it" — so a test
 * asserts the page contains it. A sentence typed into a template is a sentence a later edit
 * can reword past the assertion; one constant, rendered in one place and asserted from the
 * test, cannot drift.
 *
 * The *reason* for the rule is what makes it worth stating rather than assuming: ADR 0015
 * keeps a shelter's verification entries after a Departure has destroyed its contact points
 * and its account email, so a volunteer's name written here outlives every other trace of
 * the people who ran the shelter — including their means of asking for it back.
 */
export const EVIDENCE_RULE =
  "Describe public artifacts, never people. Link the account, the page, the article. " +
  "A verification entry outlives the shelter it is about — a person named here has no " +
  "way to ask for it back.";

/**
 * The shelter facts a verification entry attests to, and the two the dead-man's switch
 * watches (ADR 0019).
 *
 * The display name and the contact points, because those are what the decision page puts in
 * front of the admin and therefore what the judgement was made against. Not the base region
 * — a shelter that moves is still the shelter that was checked — and not the account email,
 * which is a credential the admin never sees.
 */
export interface CitedArtifacts {
  readonly displayName: string;
  readonly contactPoints: readonly StoredContactPoint[];
}

/**
 * The stored form of a cited contact-point set: a JSON array of `[kind, value]` pairs,
 * **sorted**.
 *
 * Sorted, so that two snapshots are equal exactly when they hold the same channels — which
 * makes *reordering* deliberately not a drift. The order decides which channel an adopter is
 * offered first (`CONTEXT.md`, *Contact Point*), so it is a real decision, but every channel
 * on the list was in front of the admin either way; promoting one checked channel over
 * another is not a change to what was checked.
 *
 * Pairs rather than objects, and JSON rather than a delimiter: these values are text a
 * shelter typed, and any separator we chose would be a separator a shelter can type.
 */
export function canonicalCitedContactPoints(
  points: readonly StoredContactPoint[],
): string {
  const pairs = points
    .map((point) => [point.kind, point.value] as const)
    .sort((left, right) =>
      left[0] === right[0]
        ? left[1].localeCompare(right[1])
        : left[0].localeCompare(right[0]),
    );
  return JSON.stringify(pairs);
}

/**
 * The Cited Artifacts as an entry stores them: the two canonical strings that go into
 * `verifications.cited_display_name` and `cited_contact_points`.
 *
 * Named for the glossary term rather than as a "snapshot", which is on *Cited Artifact*'s
 * own **_Avoid_** list in `CONTEXT.md` — and that list "bind[s] identifiers, types". The
 * prose in this repository still says *snapshot* where it is describing the idea, which the
 * Language section permits; what it must not do is let a second word for the concept into
 * the code, where two names for one thing is how a glossary stops being one.
 */
export interface StoredCitedArtifacts {
  readonly citedDisplayName: string;
  readonly citedContactPoints: string;
}

export function storedCitedArtifacts(
  artifacts: CitedArtifacts,
): StoredCitedArtifacts {
  return {
    citedDisplayName: artifacts.displayName,
    citedContactPoints: canonicalCitedContactPoints(artifacts.contactPoints),
  };
}

/**
 * The reverse of {@link canonicalCitedContactPoints}, beside its encoder rather than in the
 * module that happens to call it.
 *
 * Here for the reason `encodeMethods`/`decodeMethods` are one pair in one file: a codec split
 * across two modules is two things that have to agree about a format neither of them owns.
 * This half lived in `decide.ts` until review pointed that out.
 *
 * **Tolerant of anything it cannot read, and filtered rather than cast.** This parses
 * *history*: a snapshot written under an older encoding, or naming a channel the platform has
 * since dropped, must not make the drift email throw — that email is the only thing telling
 * the admin a verified shelter has moved, and failing to send it is worse than sending one
 * with a shorter list. The filter is what `decodeMethods` already does and this did not: an
 * unfiltered cast let an unknown kind through to `CONTACT_POINT_LABELS`, which would render
 * `undefined: value` in the very mail this comment says must not fail.
 */
export function parseCitedContactPoints(
  stored: string,
): readonly StoredContactPoint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const points: StoredContactPoint[] = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [kind, value] = entry;
    if (typeof kind !== "string" || typeof value !== "string") continue;
    if (!(CONTACT_POINT_KINDS as readonly string[]).includes(kind)) continue;
    points.push({ kind: kind as ContactPointKind, value });
  }
  return points;
}

function matches(
  stored: StoredCitedArtifacts,
  artifacts: CitedArtifacts,
): boolean {
  return (
    stored.citedDisplayName === artifacts.displayName &&
    stored.citedContactPoints ===
      canonicalCitedContactPoints(artifacts.contactPoints)
  );
}

/**
 * Whether this edit is the moment a verified shelter stopped matching what was cited about
 * it — the dead-man's switch's whole predicate (ADR 0019).
 *
 * **A transition and not a comparison**, which is what makes the ticket's "emails the admin
 * exactly once" true without storing anything. Asking only "does the shelter still match the
 * snapshot" would fire on every subsequent save forever, so a shelter that renamed itself
 * once and then edited a phone number twice would send three emails about one drift — and a
 * verified shelter would hold an unbounded mail tap. Asking whether the *previous* state
 * matched narrows it to the edit that broke the match.
 *
 * A shelter that edits away and then puts the cited values back sends one email and then
 * none, which is the honest reading: the site again says what the admin checked.
 */
export function citedArtifactsDrifted(
  stored: StoredCitedArtifacts,
  before: CitedArtifacts,
  after: CitedArtifacts,
): boolean {
  return matches(stored, before) && !matches(stored, after);
}
