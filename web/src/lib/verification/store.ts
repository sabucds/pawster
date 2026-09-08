/**
 * Every query the verification log makes, and nothing else.
 *
 * Apart from `../auth/store.ts` and `../shelter/store.ts` on the same boundary those two
 * draw for themselves. What lands here is the log: appending an entry, reading a shelter's
 * entries, listing what is waiting, and the one count the admin-mail ceiling is judged
 * against.
 *
 * **`readShelterProfile()` is reused rather than re-queried**, deliberately. The decision
 * page needs a shelter's display name, slug, region and contact points, and the outcome mail
 * needs its account email — which is exactly a `ShelterProfile`. Writing a select here would
 * also have meant adding this file to `ACCOUNT_EMAIL_READERS` in
 * `scripts/check-source-rules.mjs`, and the fence is worth more than the round trip: the
 * fewer files that can name that column, the more the list means.
 *
 * No Drizzle client is built here — every function takes one. `db/src/index.ts` requires the
 * client to be constructed inside the request handler, and a module that built its own would
 * be the exact shape `scripts/check-source-rules.mjs` fails the build over.
 */

import type { Database, Verification } from "@pawster/db";
import { shelterContactPoints, shelters, verifications } from "@pawster/db";
import type { VerificationOutcome } from "@pawster/domain";
import { count, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import type { CitedArtifacts } from "./policy.ts";
import { snapshotOf } from "./policy.ts";
import type { VerificationMethod } from "./policy.ts";
import { encodeMethods } from "./decision.ts";

export interface VerificationEntryInput {
  readonly shelterId: string;
  readonly outcome: VerificationOutcome;
  readonly methods: readonly VerificationMethod[];
  readonly evidence: string;
  /** The address the signed link was sent to. Not a foreign key — ADR 0002. */
  readonly decidedBy: string;
  /** What the shelter looked like at the moment of the judgement (ADR 0019). */
  readonly cited: CitedArtifacts;
}

/**
 * Append one entry. **The only write this table has, and it is an insert.**
 *
 * There is no update and no delete anywhere in this package, which is what "append-only"
 * means in practice: ADR 0003 keeps the log so that "a later judgement never erases the
 * reasoning behind an earlier one", and the way to keep that promise is for no code path to
 * exist that could. A second decision about the same shelter reaches this same function and
 * adds a row.
 *
 * The `id` is left to SQLite, which is the point of it being a sequence rather than a UUID:
 * append order is assigned by the database, so two decisions racing cannot land in an order
 * that disagrees with the order they were committed in.
 */
export async function appendVerification(
  db: Database,
  entry: VerificationEntryInput,
  now: Date,
): Promise<void> {
  const snapshot = snapshotOf(entry.cited);
  await db.insert(verifications).values({
    shelterId: entry.shelterId,
    outcome: entry.outcome,
    methods: encodeMethods(entry.methods),
    evidence: entry.evidence,
    decidedAt: now,
    decidedBy: entry.decidedBy,
    citedDisplayName: snapshot.citedDisplayName,
    citedContactPoints: snapshot.citedContactPoints,
  });
}

/**
 * One shelter's entries, newest first — the decision page's whole history panel.
 *
 * Unbounded, because the bound is the domain's: a shelter accumulates one entry per
 * judgement a human made about it, and a shelter with more than a handful is a shelter the
 * admin needs to see all of.
 */
export async function readVerificationLog(
  db: Database,
  shelterId: string,
): Promise<readonly Verification[]> {
  return await db
    .select()
    .from(verifications)
    .where(eq(verifications.shelterId, shelterId))
    .orderBy(desc(verifications.id));
}

/**
 * The latest entry, or `null` where a shelter has none.
 *
 * `null` is *pending* and not an error — ADR 0003 makes pending the absence of an entry, so
 * the absence is returned as an absence rather than as a third outcome.
 *
 * Ordered by `id` and not by `decidedAt`: the sequence is the append order the database
 * assigned, and two decisions inside one millisecond are indistinguishable by the clock. See
 * `db/src/schema.ts` for why that matters — a tie broken differently on each read would make
 * a shelter's standing depend on which query ran.
 */
export async function readLatestVerification(
  db: Database,
  shelterId: string,
): Promise<Verification | null> {
  const [row] = await db
    .select()
    .from(verifications)
    .where(eq(verifications.shelterId, shelterId))
    .orderBy(desc(verifications.id))
    .limit(1);
  return row ?? null;
}

/**
 * The one fact `domain/`'s `isListed()` wants from this table.
 *
 * Split out from {@link readLatestVerification} because the listing rule asks it on every
 * page that renders an animal, and a rule that only needs three words should not be handed
 * an admin's evidence text to not look at — the same argument `ShelterFacts` makes for
 * taking a contact-point *count* instead of the points.
 */
export async function readLatestVerificationOutcome(
  db: Database,
  shelterId: string,
): Promise<VerificationOutcome | null> {
  const [row] = await db
    .select({ outcome: verifications.outcome })
    .from(verifications)
    .where(eq(verifications.shelterId, shelterId))
    .orderBy(desc(verifications.id))
    .limit(1);
  return row?.outcome ?? null;
}

/** One row of the pending list. No contact points: those are on the decision page. */
export interface PendingShelter {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly baseRegion: string;
  readonly countryCode: string;
  readonly registeredAt: Date;
  /** How many contact points it offers, so the admin can see a shelter it cannot reach. */
  readonly contactPointCount: number;
}

/**
 * Every shelter awaiting a first judgement, longest wait first.
 *
 * **"Pending" is expressed as `NOT IN (SELECT shelter_id FROM verifications)`**, which is
 * ADR 0003's "pending is the absence of any entry" written as SQL rather than as a status
 * predicate. A shelter that was refused is *not* here: it has an entry, the judgement was
 * made, and the queue is a list of decisions owed rather than a list of unhappy shelters.
 *
 * Oldest first, because the list exists to answer "who has been waiting longest" — the
 * promise the shelter was given at registration is three days, and a queue sorted any other
 * way hides the one that is about to break it.
 */
export async function readPendingShelters(
  db: Database,
): Promise<readonly PendingShelter[]> {
  const decided = db.select({ id: verifications.shelterId }).from(verifications);

  return await db
    .select({
      id: shelters.id,
      slug: shelters.slug,
      displayName: shelters.displayName,
      baseRegion: shelters.baseRegion,
      countryCode: shelters.countryCode,
      registeredAt: shelters.createdAt,
      contactPointCount: sql<number>`(
        select count(*) from ${shelterContactPoints}
        where ${shelterContactPoints.shelterId} = ${shelters.id}
      )`,
    })
    .from(shelters)
    .where(notInArray(shelters.id, decided))
    .orderBy(shelters.createdAt);
}

/**
 * How many shelters registered inside the window — the admin-mail ceiling's whole ledger.
 *
 * There is no table of decision emails, and there should not be one: exactly one decision
 * email is sent per shelter created, so `shelters.created_at` already holds the history the
 * ceiling is a question about. `policy.ts`'s `refuseAdminMail()` says why a ceiling exists
 * at all and why refusing a send is safe.
 */
export async function countRegistrationsSince(
  db: Database,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(shelters)
    .where(gte(shelters.createdAt, since));
  return row?.n ?? 0;
}
