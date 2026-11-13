/**
 * The digest's reads and its one write that is not a purge. No Drizzle client is built here;
 * every function takes one (`db/src/index.ts`).
 *
 * Every read joins through `subscribers.send_day` rather than passing ids in an `IN` list,
 * because D1 caps a statement at 100 bound parameters and a shard is up to
 * `DIGEST_DAILY_BUDGET` subscribers with up to three searches each.
 */

import type { Database } from "@pawster/db";
import {
  animals,
  digestSent,
  shelterContactPoints,
  shelters,
  subscribers,
  subscriptions,
  uploadSessionPhotos,
  verifications,
} from "@pawster/db";
import type {
  DigestAnimal,
  Sex,
  ShelterFacts,
  Size,
  Species,
} from "@pawster/domain";
import { isListed } from "@pawster/domain";
import { and, eq, isNull, sql } from "drizzle-orm";

/** The same two shelter-level facts `web/src/lib/listing/store.ts` reads, the same way. */
const contactPointCount = sql<number>`(
  select count(*) from ${shelterContactPoints}
  where ${shelterContactPoints.shelterId} = ${animals.shelterId}
)`;

const latestVerificationOutcome = sql<
  ShelterFacts["latestVerificationOutcome"]
>`(
  select ${verifications.outcome} from ${verifications}
  where ${verifications.shelterId} = ${animals.shelterId}
  order by ${verifications.id} desc limit 1
)`;

/**
 * Every listed animal, read once per run and matched against every search in the shard.
 *
 * The SQL selects candidates and `isListed()` decides, for the reason the web store gives:
 * one statement of the listing rule, in the package that can unit-test it.
 *
 * `matchable_since` is deliberately not a filter here. It is set once at publication, so an
 * animal whose region was corrected, or who grew into a younger subscriber's age band, has an
 * old `matchable_since` and must still arrive. The sent-set alone decides what is new.
 */
export async function readListedForDigest(db: Database): Promise<DigestAnimal[]> {
  const rows = await db
    .select({
      id: animals.id,
      species: animals.species,
      region: animals.region,
      sex: animals.sex,
      size: animals.size,
      estimatedBirthDate: animals.estimatedBirthDate,
      goodWithChildren: animals.goodWithChildren,
      goodWithDogs: animals.goodWithDogs,
      goodWithCats: animals.goodWithCats,
      availability: animals.availability,
      bondedGroupId: animals.bondedGroupId,
      contactPointCount,
      latestVerificationOutcome,
      departedAt: shelters.departedAt,
    })
    .from(animals)
    /**
     * Load-bearing beyond referential tidiness: Drizzle qualifies column names only when a
     * statement has a join, and unqualified, the subqueries' `shelter_id = shelter_id` compares
     * a column with itself and lists every animal of an unverified shelter.
     */
    .innerJoin(shelters, eq(shelters.id, animals.shelterId));

  return rows
    .filter((row) =>
      isListed(
        { availability: row.availability },
        {
          latestVerificationOutcome: row.latestVerificationOutcome,
          contactPointCount: row.contactPointCount,
          departedAt: row.departedAt,
        },
      ),
    )
    .map((row) => ({
      id: row.id,
      species: row.species,
      region: row.region,
      sex: row.sex,
      size: row.size,
      estimatedBirthDate: row.estimatedBirthDate,
      goodWith: {
        children: row.goodWithChildren,
        dogs: row.goodWithDogs,
        cats: row.goodWithCats,
      },
      bondedGroupId: row.bondedGroupId,
    }));
}

/** Who may be mailed today: today's send day, neither unsubscribed nor retired. */
const mailable = (sendDay: number) =>
  and(
    eq(subscribers.sendDay, sendDay),
    isNull(subscribers.unsubscribedAt),
    isNull(subscribers.retiredAt),
  );

/** Every saved search belonging to today's shard, in slot order. */
export function readShardSubscriptions(db: Database, sendDay: number) {
  return db
    .select({
      id: subscriptions.id,
      subscriberId: subscriptions.subscriberId,
      criteria: subscriptions.criteria,
    })
    .from(subscriptions)
    .innerJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(mailable(sendDay))
    .orderBy(subscriptions.subscriberId, subscriptions.slot);
}

/** The sent-set of every search in today's shard, keyed by subscription. */
export async function readShardSentSets(
  db: Database,
  sendDay: number,
): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({
      subscriptionId: digestSent.subscriptionId,
      animalId: digestSent.animalId,
    })
    .from(digestSent)
    .innerJoin(subscriptions, eq(subscriptions.id, digestSent.subscriptionId))
    .innerJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(mailable(sendDay));

  const sets = new Map<string, Set<string>>();
  for (const row of rows) {
    let set = sets.get(row.subscriptionId);
    if (!set) sets.set(row.subscriptionId, (set = new Set()));
    set.add(row.animalId);
  }
  return sets;
}

export { mailable };

/** What one row of the email needs about one animal. */
export interface DigestRowAnimal {
  id: string;
  name: string;
  species: Species;
  sex: Sex;
  size: Size | null;
  estimatedBirthDate: Date;
  region: string;
  lastConfirmedAt: Date;
  /** The primary photo's source digest, or null for an animal with no photo row. */
  sourceDigest: string | null;
}

/**
 * The animals one email shows, for the consumer to render. One statement however many rows:
 * the ids go in as a single JSON array through `json_each`, so D1's 100-parameter cap is never
 * near. The join keeps every column qualified, which a Drizzle select over one table does not.
 *
 * Not filtered by `isListed()`: the producer decided what to send, and an animal adopted in the
 * minutes since is still the animal the email was composed with. One that was deleted outright
 * is simply missing from the result, and its row is dropped.
 */
export async function readDigestRows(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, DigestRowAnimal>> {
  const rows = await db
    .select({
      id: animals.id,
      name: animals.name,
      species: animals.species,
      sex: animals.sex,
      size: animals.size,
      estimatedBirthDate: animals.estimatedBirthDate,
      region: animals.region,
      lastConfirmedAt: animals.lastConfirmedAt,
      sourceDigest: uploadSessionPhotos.sourceDigest,
    })
    .from(animals)
    .leftJoin(
      uploadSessionPhotos,
      and(
        eq(uploadSessionPhotos.sessionId, animals.uploadSessionId),
        eq(uploadSessionPhotos.position, 0),
      ),
    )
    .where(sql`${animals.id} in (select value from json_each(${JSON.stringify(ids)}))`);
  return new Map(rows.map((row) => [row.id, row]));
}
