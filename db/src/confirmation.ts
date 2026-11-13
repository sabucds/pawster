/**
 * The reads and writes behind the monthly Confirmation Nudge (issue #60, ADR 0008).
 *
 * In `db/` because `digest/` sends the nudge and `web/` serves the page it opens, and both
 * need the same idea of which animals are owed a confirmation.
 */

import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "./index.ts";
import { animals, shelters, verifications } from "./schema.ts";

/** Pending, refused and revoked shelters are never nudged: only a latest `Verified` counts. */
const latestOutcome = sql<string | null>`(
  select ${verifications.outcome} from ${verifications}
  where ${verifications.shelterId} = ${shelters.id}
  order by ${verifications.id} desc limit 1
)`;

export interface ShelterNudge {
  readonly shelterId: string;
  readonly accountEmail: string;
  readonly nudgeVersion: number;
  /** Names of the Available animals unconfirmed since `staleBefore`, by name. */
  readonly animalNames: readonly string[];
}

/**
 * Verified shelters that have not asked to leave, with at least one Available animal confirmed
 * no later than `staleBefore`, and not nudged since `nudgedBefore`. One entry per shelter,
 * because a nudge is one email per shelter and never one per animal.
 */
export async function findShelterNudgesOwed(
  db: Database,
  cutoffs: { readonly staleBefore: Date; readonly nudgedBefore: Date },
  limit: number,
): Promise<ShelterNudge[]> {
  const owed = await db
    .select({
      shelterId: shelters.id,
      accountEmail: shelters.accountEmail,
      nudgeVersion: shelters.nudgeVersion,
    })
    .from(shelters)
    .where(
      and(
        eq(latestOutcome, "Verified"),
        isNull(shelters.departedAt),
        or(isNull(shelters.nudgedAt), lte(shelters.nudgedAt, cutoffs.nudgedBefore)),
        sql`exists (
          select 1 from ${animals}
          where ${animals.shelterId} = ${shelters.id}
            and ${animals.availability} = 'Available'
            and ${animals.lastConfirmedAt} <= ${cutoffs.staleBefore.getTime()}
        )`,
      ),
    )
    .orderBy(asc(shelters.nudgedAt), asc(shelters.id))
    .limit(limit);
  if (owed.length === 0) return [];

  const stale = await db
    .select({ shelterId: animals.shelterId, name: animals.name })
    .from(animals)
    .where(
      and(
        inArray(
          animals.shelterId,
          owed.map((row) => row.shelterId),
        ),
        eq(animals.availability, "Available"),
        lte(animals.lastConfirmedAt, cutoffs.staleBefore),
      ),
    )
    .orderBy(asc(animals.name));

  return owed.map((row) => ({
    ...row,
    animalNames: stale.filter((a) => a.shelterId === row.shelterId).map((a) => a.name),
  }));
}

/**
 * Record a nudge that was actually sent: its version becomes the only live link. Conditional
 * on the version the email was built against, so two overlapping runs cannot both advance it
 * and leave the delivered link already superseded.
 */
export async function recordShelterNudge(
  db: Database,
  nudge: { readonly shelterId: string; readonly sentVersion: number },
  now: Date,
): Promise<void> {
  await db
    .update(shelters)
    .set({ nudgeVersion: nudge.sentVersion, nudgedAt: now })
    .where(
      and(eq(shelters.id, nudge.shelterId), eq(shelters.nudgeVersion, nudge.sentVersion - 1)),
    );
}
