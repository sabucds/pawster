/**
 * Every query a shelter's own profile makes, and nothing else.
 *
 * Apart from `../auth/store.ts` on the boundary that file draws for itself — "every query
 * shelter access makes, and nothing else". Signing in and editing a display name are
 * different concerns, and the one place they meet is `changeAccountEmail()` below, which is
 * an access act wearing a profile form: it is the only write on this platform that ends a
 * session.
 *
 * No Drizzle client is built here — every function takes one. `db/src/index.ts` requires the
 * client to be constructed inside the request handler, and a module that built its own
 * would be the exact shape `scripts/check-source-rules.mjs` fails the build over.
 */

import type { Database } from "@pawster/db";
import { oneTimeCodes, shelterContactPoints, shelters } from "@pawster/db";
import type { ContactPointKind } from "@pawster/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type { ContactPointInput } from "./fields.ts";
import type { ProfileInput } from "./profile.ts";

export interface StoredContactPoint {
  readonly kind: ContactPointKind;
  readonly value: string;
}

export interface ShelterProfile {
  readonly displayName: string;
  /** Shown so a shelter can see its public address, never as an editable field. */
  readonly slug: string;
  readonly accountEmail: string;
  readonly baseRegion: string;
  readonly countryCode: string;
  /** In the shelter's own order. The first is the one an adopter is offered. */
  readonly contactPoints: readonly StoredContactPoint[];
}

/**
 * Everything the profile form renders, or `null` if the shelter is gone.
 *
 * Two queries rather than a join, because a join over one shelter and a handful of contact
 * points returns the shelter's columns once per point and then has to be un-flattened in the
 * Worker. At this size the second round trip is cheaper than the code that would avoid it.
 */
export async function readShelterProfile(
  db: Database,
  shelterId: string,
): Promise<ShelterProfile | null> {
  const [shelter] = await db
    .select({
      displayName: shelters.displayName,
      slug: shelters.slug,
      accountEmail: shelters.accountEmail,
      baseRegion: shelters.baseRegion,
      countryCode: shelters.countryCode,
    })
    .from(shelters)
    .where(eq(shelters.id, shelterId))
    .limit(1);
  if (!shelter) return null;

  return { ...shelter, contactPoints: await readStoredContactPoints(db, shelterId) };
}

/**
 * A shelter's contact points, in its own order. `ORDER BY position` is the whole rule.
 *
 * Named `Stored` to hold it apart from `fields.ts`'s `readContactPoints()`, which reads a
 * *form*. Two exported functions in one module family sharing a name, differing only in
 * whether their first argument is a `Database` or a `FormData`, is a name that reveals
 * nothing about which one a call site means.
 */
export async function readStoredContactPoints(
  db: Database,
  shelterId: string,
): Promise<readonly StoredContactPoint[]> {
  return await db
    .select({
      kind: shelterContactPoints.kind,
      value: shelterContactPoints.value,
    })
    .from(shelterContactPoints)
    .where(eq(shelterContactPoints.shelterId, shelterId))
    .orderBy(shelterContactPoints.position);
}

/**
 * Replace a shelter's contact points with this list, in this order.
 *
 * **Wholesale replacement, in one batch, and both halves of that matter.**
 *
 * *Wholesale*, because the form submits the complete set every time and a diff against what
 * is stored would be more code with nothing to show for it: no row here is an address
 * anything holds. Nothing references a contact point's id — unlike `shelters.slug`, which is
 * immutable precisely because adopters and search engines hold it — so a replaced row is
 * indistinguishable from a mutated one, and the replacement expresses reordering for free.
 * A diff would also have to decide what an "unchanged" point is, and a shelter that retyped
 * its own WhatsApp number identically would be a no-op it had to detect.
 *
 * *In one batch*, because the delete alone is a delisting. `domain/`'s `isListed()` has a
 * `contactPointCount > 0` clause, so a shelter whose delete landed and whose insert did not
 * has every animal it published invisible, with nothing on any screen to say so. `db.batch()`
 * is D1's atomic unit — the statements commit together or not at all — which is what keeps
 * the intermediate state from existing rather than merely from being brief.
 *
 * @throws if handed an empty list. The callers refuse that in their parsers, where the
 *   shelter can be told why; reaching here with nothing is a bug, and a bug that silently
 *   delisted a shelter's animals is worse than one that throws.
 */
export async function writeContactPoints(
  db: Database,
  shelterId: string,
  points: readonly ContactPointInput[],
  now: Date,
): Promise<void> {
  if (points.length === 0) {
    throw new Error(
      `refusing to leave shelter ${shelterId} with no contact point: every animal it ` +
        "published would stop being listed",
    );
  }

  await db.batch([
    db
      .delete(shelterContactPoints)
      .where(eq(shelterContactPoints.shelterId, shelterId)),
    db.insert(shelterContactPoints).values(
      points.map((point, position) => ({
        id: crypto.randomUUID(),
        shelterId,
        kind: point.kind,
        value: point.value,
        /**
         * The index, which is the only place the order is written down. There is no
         * `primary` flag to keep in step, and no position the caller supplies that could
         * disagree with where the item actually sits in the list it sent.
         */
        position,
        createdAt: now,
      })),
    ),
  ]);
}

/**
 * Save a display name, a base region and a set of contact points.
 *
 * **`slug` is not in this update, and it never will be.** `db/src/schema.ts` makes it
 * immutable because it is an address adopters already hold, and ADR 0015 keeps a departed
 * shelter's archive pages reachable, which a slug that followed the display name would break
 * the first time a shelter fixed a typo in its own name. The enforcement is structural:
 * `scripts/check-source-rules.mjs` fails the build if any query outside `registerShelter()`
 * writes the column.
 *
 * Two writes rather than one batch of three, and that is safe for a narrow reason worth
 * stating: the only pair that must not come apart is the contact-point delete and insert,
 * because a delete alone is a delisting — and those two are batched together inside
 * `writeContactPoints()`. A name update that lands while the contact points do not leaves a
 * shelter with a new name and the contact points it already had, which is a state it could
 * have reached by submitting the form twice.
 */
export async function saveShelterProfile(
  db: Database,
  shelterId: string,
  input: ProfileInput,
  now: Date,
): Promise<void> {
  await db
    .update(shelters)
    .set({ displayName: input.displayName, baseRegion: input.baseRegion })
    .where(eq(shelters.id, shelterId));

  await writeContactPoints(db, shelterId, input.contactPoints, now);
}

/**
 * What happened to an attempted account-email change.
 *
 * `unchanged` is reported rather than treated as a successful no-op, because the *cost* of
 * this act is the thing a shelter has to be told about: it would be signed out of every
 * device for nothing. `taken` is discussed below.
 */
export type AccountEmailChange = "changed" | "unchanged" | "taken";

/**
 * Move the account to a new address, ending everything the old one could do.
 *
 * This is the one act that hands a shelter to a successor, and the reason it is one function
 * rather than a cleanup list at a call site. `CONTEXT.md` calls the account email "the
 * shelter's whole credential", so changing it has to invalidate, atomically:
 *
 * - **every live Session**, by bumping `sessionEpoch`. ADR 0013 makes that integer the whole
 *   revocation mechanism — there is no session table to walk — and `guard.ts` refuses any
 *   cookie minted under a superseded epoch. Incremented in SQL rather than read, added to and
 *   written back, so two concurrent changes produce two increments however they interleave.
 * - **the outstanding One-Time Code**, by deleting it. It was mailed to the *old* address, so
 *   leaving it alive would let whoever still holds that inbox sign in for another ten minutes
 *   after the handover — which is exactly the person the handover is taking the account away
 *   from.
 *
 * ADR 0008 requires the same of an outstanding Confirmation Nudge link: "changing the account
 * email invalidates every outstanding link". **That link's server-side state does not exist
 * yet** — issue #60 builds the nudge — and when it lands, its row is destroyed *here*, in
 * this batch, rather than by a second path that remembers to. The batch below is the list
 * ADR 0008's rule is implemented as, and it is one statement short until #60 arrives.
 *
 * The mail ledger is deliberately **not** cleared. `sign_in_requests` is what the five-minute
 * cooldown and the daily caps are counted over (ADR 0013), so wiping it here would turn an
 * email change into a way to reset an address's allowance, and this endpoint is reachable by
 * anyone holding a session.
 */
export async function changeAccountEmail(
  db: Database,
  shelterId: string,
  accountEmail: string,
): Promise<AccountEmailChange> {
  const [current] = await db
    .select({ accountEmail: shelters.accountEmail })
    .from(shelters)
    .where(eq(shelters.id, shelterId))
    .limit(1);
  if (!current) return "unchanged";
  if (current.accountEmail === accountEmail) return "unchanged";

  /**
   * Refused explicitly when another shelter already holds the address, and the trade is
   * worth naming because it runs against the posture everywhere else.
   *
   * ADR 0008 forbids the *unauthenticated* forms from revealing whether an address is
   * registered, and `registro/index.astro` goes as far as answering a duplicate registration
   * with the success page. Doing that here would be worse than an oracle: a shelter told its
   * email had changed, whose email had not changed, still holds a working session and will
   * discover the truth the next time it needs a code — at which point ADR 0013 answers a lost
   * inbox out of band, for a loss the platform manufactured. So this reports the refusal.
   *
   * What it costs is that a caller **holding a session** can test one address per attempt.
   * That is a much smaller surface than the sign-in form: it needs an account, and the answer
   * it gets is "not available", which is also what a reserved or bounced address would say.
   *
   * A read-then-write, so it is racy in principle: two shelters can claim one address in the
   * same instant. The unique index on `shelters.account_email` is the actual guarantee and the
   * loser gets a failed update — the same trade `reserveSlug()` makes, at roughly forty
   * shelters in the platform's lifetime.
   */
  const [taken] = await db
    .select({ id: shelters.id })
    .from(shelters)
    .where(and(eq(shelters.accountEmail, accountEmail), ne(shelters.id, shelterId)))
    .limit(1);
  if (taken) return "taken";

  await db.batch([
    db
      .update(shelters)
      .set({
        accountEmail,
        sessionEpoch: sql`${shelters.sessionEpoch} + 1`,
      })
      .where(eq(shelters.id, shelterId)),
    db.delete(oneTimeCodes).where(eq(oneTimeCodes.shelterId, shelterId)),
  ]);

  return "changed";
}
