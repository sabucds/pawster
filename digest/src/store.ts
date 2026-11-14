/**
 * The digest's reads and its one write that is not an Erasure. Drizzle reads take a client
 * (`db/src/index.ts`); the write takes D1 itself, because it is one `batch` of raw guarded
 * inserts.
 *
 * Every read joins through `subscribers.send_day` rather than passing ids in an `IN` list,
 * because D1 caps a statement at 100 bound parameters and a shard is up to
 * `DIGEST_DAILY_BUDGET` subscribers with up to three searches each.
 */

import type { Database } from "@pawster/db";
import {
  animals,
  contactPointCount,
  digestSent,
  latestVerificationOutcome,
  shelters,
  subscribers,
  subscriptions,
  uploadSessionPhotos,
} from "@pawster/db";
import type {
  AnimalFacts,
  DigestAnimal,
  Sex,
  ShelterFacts,
  Size,
  Species,
} from "@pawster/domain";
import { isListed } from "@pawster/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DigestSection } from "@pawster/domain";

/** `isListed()` over a row that selected the availability and the shelter facts from `db/src/shelter-facts.ts`. */
const listedRow = (row: AnimalFacts & ShelterFacts) => isListed(row, row);

/**
 * Every listed animal, read once per run and matched against every search in the shard.
 *
 * The SQL selects candidates and `isListed()` decides, for the reason the web store gives:
 * one statement of the listing rule, in the package that can unit-test it.
 *
 * `published_at` is deliberately not a filter here. An animal that grew into a subscriber's
 * age band, or that a capped email left for next week, has an old `published_at` and must
 * still arrive, so no time cutoff narrows this without changing who gets what. The sent-set
 * alone decides what is new.
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
      contactPointCount: contactPointCount(animals.shelterId),
      latestVerificationOutcome: latestVerificationOutcome(animals.shelterId),
      departedAt: shelters.departedAt,
      demo: shelters.demo,
    })
    .from(animals)
    /**
     * Load-bearing beyond referential tidiness: Drizzle qualifies column names only when a
     * statement has a join, and unqualified, the subqueries' `shelter_id = shelter_id` compares
     * a column with itself and lists every animal of an unverified shelter.
     */
    .innerJoin(shelters, eq(shelters.id, animals.shelterId));

  return rows
    .filter(listedRow)
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
      demo: row.demo,
    }));
}

/** Who may be mailed today: today's send day, neither unsubscribed nor retired. */
const mailable = (sendDay: number) =>
  and(
    eq(subscribers.sendDay, sendDay),
    isNull(subscribers.unsubscribedAt),
    isNull(subscribers.retiredAt),
  );

/** Today's shard, oldest digest first, so overflow past the budget waits the least. */
export function readShard(db: Database, sendDay: number) {
  return db
    .select({
      id: subscribers.id,
      email: subscribers.email,
      manageTokenVersion: subscribers.manageTokenVersion,
    })
    .from(subscribers)
    .where(mailable(sendDay))
    .orderBy(asc(subscribers.lastDigestAt), asc(subscribers.optedInAt));
}

/** Every Subscription belonging to today's shard, in slot order. */
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

/** The sent-set of every Subscription in today's shard, keyed by subscription. */
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
 * Filtered by `isListed()` again, at send time: delisting is immediate (#65), so an animal
 * adopted, or whose shelter asked to leave, since the run is missing from the result like one
 * deleted outright, and the consumer drops its row.
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
      availability: animals.availability,
      contactPointCount: contactPointCount(animals.shelterId),
      latestVerificationOutcome: latestVerificationOutcome(animals.shelterId),
      departedAt: shelters.departedAt,
    })
    .from(animals)
    .innerJoin(shelters, eq(shelters.id, animals.shelterId))
    .leftJoin(
      uploadSessionPhotos,
      and(
        eq(uploadSessionPhotos.sessionId, animals.uploadSessionId),
        eq(uploadSessionPhotos.position, 0),
      ),
    )
    .where(sql`${animals.id} in (select value from json_each(${JSON.stringify(ids)}))`);
  return new Map(rows.filter(listedRow).map((row) => [row.id, row]));
}

/**
 * Remember a digest that was actually sent. Only after the send succeeded: the sent-set is
 * what makes tomorrow's candidates exclude these animals, and a dropped message writes
 * nothing, so the next run simply recomputes it. `lastDigestAt` is ADR 0009's reporting
 * field; it orders the next shard's overflow and is never asked what is "new".
 */
export async function recordDigestSent(
  d1: D1Database,
  sent: {
    readonly period: string;
    readonly subscriberId: string;
    readonly sections: readonly DigestSection[];
  },
): Promise<void> {
  const sentAt = Date.now();
  const remember = d1.prepare(
    // Guarded by EXISTS rather than trusted: the Subscription can be deleted from the manage
    // page, or the animal removed, between enqueue and send, and a foreign-key failure
    // here would retry an email that already went out.
    `insert or ignore into digest_sent (subscription_id, animal_id, sent_at)
     select ?1, ?2, ?3
     where exists (select 1 from subscriptions where id = ?1)
       and exists (select 1 from animals where id = ?2)`,
  );
  await d1.batch([
    d1.prepare("update subscribers set last_digest_at = ? where id = ?").bind(
      sentAt,
      sent.subscriberId,
    ),
    // The Digest Delivery (`CONTEXT.md`): the subscriber's id and never the address,
    // kept 90 days by the preamble. Guarded for the same reason as the sent-set rows.
    d1.prepare(
      `insert into digest_deliveries (id, subscriber_id, period, sent_at)
       select ?1, ?2, ?3, ?4 where exists (select 1 from subscribers where id = ?2)`,
    ).bind(crypto.randomUUID(), sent.subscriberId, sent.period, sentAt),
    ...sent.sections.flatMap((section) =>
      [...section.units, ...section.repeats]
        .flat()
        .map((animalId) => remember.bind(section.subscriptionId, animalId, sentAt)),
    ),
  ]);
}
