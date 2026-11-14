import type { Database } from "@pawster/db";
import { shelters } from "@pawster/db";
import { departureErasureCutoff } from "@pawster/domain";
import { and, eq, gt, isNull } from "drizzle-orm";

/**
 * Departure and its cancel (ADR 0015, issue #65): one column, set or cleared.
 *
 * **Neither act touches an animal.** Every animal leaves the listing because `isListed()` has a
 * `departedAt === null` clause, and the filter index is rewritten whole from D1 afterwards, so a
 * roster of dozens is one shelter UPDATE and one regeneration. That is what keeps the act from
 * being quadratic and from leaving a shelter half-departed: there is no per-animal write to be
 * interrupted between. Animals keep their availability, so no fourth state exists.
 *
 * **Nothing is destroyed here.** The erasure at the end of the grace period belongs to the daily
 * preamble (issue #66), which reads `departedAt` against `departureErasureCutoff()`.
 */

export type DepartureOutcome = "departed" | "name-mismatch";

/**
 * Leave Pawster, if `typedName` is the shelter's display name exactly (after trimming the ends).
 *
 * The typed name is the whole confirmation: it is the shelter's public identity and the thing
 * the archive pages keep, so typing it is a deliberate act and not a misclick.
 *
 * Idempotent: a second request leaves the first `departedAt` in place, so a double submit
 * cannot move the erasure date.
 */
export async function requestDeparture(
  db: Database,
  shelterId: string,
  typedName: string,
  now: Date,
): Promise<DepartureOutcome> {
  const [shelter] = await db
    .select({ displayName: shelters.displayName })
    .from(shelters)
    .where(eq(shelters.id, shelterId))
    .limit(1);
  if (!shelter || typedName.trim() !== shelter.displayName) return "name-mismatch";

  await db
    .update(shelters)
    .set({ departedAt: now })
    .where(and(eq(shelters.id, shelterId), isNull(shelters.departedAt)));
  return "departed";
}

/**
 * Undo a departure still inside its grace period. Returns whether anything was restored.
 *
 * Bounded by the same cutoff the erasure uses, so the two can never both apply: a departure
 * the preamble is entitled to erase is one this refuses to cancel.
 */
export async function cancelDeparture(
  db: Database,
  shelterId: string,
  now: Date,
): Promise<boolean> {
  const restored = await db
    .update(shelters)
    .set({ departedAt: null })
    .where(
      and(
        eq(shelters.id, shelterId),
        gt(shelters.departedAt, departureErasureCutoff(now)),
      ),
    )
    .returning({ id: shelters.id });
  return restored.length > 0;
}
