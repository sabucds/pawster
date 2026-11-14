/**
 * Confirmations that are not edits: the "sigue disponible" click, confirm-all, and a state
 * change from the nudge page (issue #60).
 *
 * Each one records where it came from, `session` or `link`, because ADR 0008 lets a forwarded
 * link act and wants the provenance kept. Every write is scoped to the shelter, so an id for
 * another shelter's animal changes nothing.
 */

import type { Database } from "@pawster/db";
import { animals, shelters } from "@pawster/db";
import type { Availability, ConfirmableShelter } from "@pawster/domain";
import { type SQL, and, eq, isNull, or, sql } from "drizzle-orm";

export type ConfirmedVia = "session" | "link";

/**
 * The animal and every member of its bonded group. A group is adopted and confirmed together,
 * so a Confirmation, and a state change, reach all of it. Read through a subquery, so it sees
 * the group as it stands when the statement runs, after any bond written earlier in a batch.
 */
export function withItsGroup(animalId: string): SQL {
  return or(
    eq(animals.id, animalId),
    eq(
      animals.bondedGroupId,
      sql`(select ${animals.bondedGroupId} from ${animals} where ${animals.id} = ${animalId})`,
    ),
  )!;
}

/**
 * What `verifyConfirmationToken()` needs from the row. A shelter that has asked to leave reads
 * as missing, so its links answer like expired ones: nothing it leaves behind is confirmed
 * from an email. Signed in, it can still confirm during the grace period (#65).
 */
export async function readConfirmableShelter(
  db: Database,
  shelterId: string,
): Promise<ConfirmableShelter | null> {
  const [row] = await db
    .select({ accountEmail: shelters.accountEmail, nudgeVersion: shelters.nudgeVersion })
    .from(shelters)
    .where(and(eq(shelters.id, shelterId), isNull(shelters.departedAt)))
    .limit(1);
  return row ?? null;
}

/** Confirm-all: every animal of the shelter that is still listed as available. */
export async function confirmAllAvailable(
  db: Database,
  shelterId: string,
  via: ConfirmedVia,
  now: Date,
): Promise<void> {
  await db
    .update(animals)
    .set({ lastConfirmedAt: now, lastConfirmedVia: via })
    .where(and(eq(animals.shelterId, shelterId), eq(animals.availability, "Available")));
}

/**
 * Confirm one animal, and change its state when `availability` is given. A bonded group is
 * adopted and confirmed together, so both reach every member, as in `editAnimal()`.
 *
 * Relisting is this same call with `Available`: the row keeps its id, photos and
 * `matchableSince`, and only the state and the confirmation move.
 */
export async function confirmAnimal(
  db: Database,
  owner: { readonly shelterId: string; readonly animalId: string },
  change: { readonly via: ConfirmedVia; readonly now: Date; readonly availability?: Availability },
): Promise<void> {
  await db
    .update(animals)
    .set({
      lastConfirmedAt: change.now,
      lastConfirmedVia: change.via,
      ...(change.availability ? { availability: change.availability } : {}),
    })
    .where(
      and(
        eq(animals.shelterId, owner.shelterId),
        withItsGroup(owner.animalId),
      ),
    );
}
