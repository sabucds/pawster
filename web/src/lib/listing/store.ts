/**
 * The one read a regeneration makes: every animal an adopter may see, in id order.
 *
 * [ADR 0018](../../../../docs/adr/0018-the-filter-index-is-rewritten-whole-and-found-through-a-pointer.md)
 * costs a regeneration at **six subrequests**, one of which is "read the listable set from
 * D1" — singular. That is the constraint this file exists to satisfy, and it is what shapes
 * the query: the four clauses of the listing rule draw on three tables, and asking about
 * them per shelter would be forty shelters' worth of round trips against a 50-subrequest
 * limit. So the two shelter-level facts arrive as correlated subqueries in the same
 * statement, and the primary photograph arrives as a join.
 *
 * No Drizzle client is built here; every function takes one (`db/src/index.ts`).
 *
 * ## The rule is `domain/`'s, and this file only supplies its inputs
 *
 * The SQL selects **candidates**, not listed animals: it narrows nothing except by joining
 * what the rule needs. `isListed()` is then asked once per row. That is deliberate, and it
 * is the same reason `domain/src/listing.ts` gives for taking flat facts rather than rows —
 * a four-clause `WHERE` here would be a second statement of the rule, in a language where
 * it cannot be unit-tested, and the first ticket to change a clause would change one of the
 * two. Issue #56 requires that only animals satisfying the four-clause rule appear in the
 * index; the way to be sure of that is to have exactly one expression of it.
 *
 * The cost of that choice is honest and small: the read carries rows the rule then drops. At
 * ADR 0012's ceiling those are ~12,500 rows to yield ~2,500, which is marshalling rather
 * than I/O, and it is the same order of work ADR 0018 already put on the CPU-ceiling
 * measurement list.
 */

import type { Database } from "@pawster/db";
import {
  animals,
  shelterContactPoints,
  shelters,
  uploadSessionPhotos,
  verifications,
} from "@pawster/db";
import type { GoodWithFlags, ListedAnimal, ShelterFacts } from "@pawster/domain";
import { isListed } from "@pawster/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { derivativeKey } from "../photos/keys.ts";

/**
 * How many listed animals were dropped for want of a photograph, and why that is a number
 * rather than an exception.
 *
 * A listed animal with no primary photograph cannot be put on a card — there is nothing to
 * put in the box. It is also a broken invariant rather than a state the platform creates:
 * `domain/`'s `MIN_PHOTOS_PER_ANIMAL` refuses a publish with no photograph, and the animal's
 * `upload_session_id` is a foreign key, so reaching this state takes a photo row being
 * deleted underneath a published animal.
 *
 * Aborting the regeneration would be worse than the fault it reports: ADR 0018 says a
 * regeneration "aborts on an incomplete read, and **only** on that", because every other
 * abort withholds a whole catalogue over one row. And a tombstone row for a later job to
 * find is the shape ADR 0016 rejects. So the animal is left out and counted, and the count
 * travels back to the caller that asked for the regeneration — which is what lets issue
 * #66's run summary report it beside reclamation's counts instead of nobody ever knowing.
 */
export interface ListableRead {
  readonly animals: readonly ListedAnimal[];
  readonly withoutPhoto: number;
}

/**
 * How many public contact points the shelter offers, as a scalar subquery.
 *
 * A count and not the points, matching `ShelterFacts`: the rule only asks whether an adopter
 * can reach anyone, and handing a pure function a volunteer's WhatsApp number to not look at
 * is worse than not having it.
 */
const contactPointCount = sql<number>`(
  select count(*) from ${shelterContactPoints}
  where ${shelterContactPoints.shelterId} = ${animals.shelterId}
)`;

/**
 * The outcome off the top of the shelter's append-only log
 * ([ADR 0003](../../../../docs/adr/0003-verification-is-an-append-only-log.md)), or `null`
 * where it has none — which is *pending*, spelled as the absence it is.
 *
 * Ordered by the log's `id` and never by `decidedAt`, for the reason `db/src/schema.ts`
 * gives: two decisions in the same millisecond are indistinguishable by the clock, so the
 * clock is not a total order and a shelter could read `Verified` or `Revoked` depending on
 * which query ran. This is `../verification/store.ts`'s `readLatestVerificationOutcome`
 * expressed for a set rather than for one shelter — the same definition of "latest",
 * because it is the same `ORDER BY`.
 */
const latestVerificationOutcome = sql<
  ShelterFacts["latestVerificationOutcome"]
>`(
  select ${verifications.outcome} from ${verifications}
  where ${verifications.shelterId} = ${animals.shelterId}
  order by ${verifications.id} desc limit 1
)`;

/**
 * Every animal an adopter may see, with the thumbnail its card shows, in id order.
 *
 * **The `ORDER BY` is load-bearing and it is one line of SQL.** ADR 0018's free nightly
 * no-op rests on identical data serializing to identical bytes: without an explicit order
 * the row order is whatever D1 returns, two runs over an unchanged catalogue serialize
 * differently, every run mints a new key, and the no-op quietly becomes a nightly write plus
 * an orphan. `domain/`'s `serializeIndex` sorts as well, and neither is redundant — that one
 * holds the invariant for any caller, this one holds it where the ADR argued for it.
 *
 * **Incompleteness is detected from the read's own contract**, which for a single Drizzle
 * statement means the promise rejecting. Nothing here catches that: the rejection propagates
 * to {@link regenerateIndex}, which leaves the pointer where it is so the previous index
 * stands. There is no row-count guard, and ADR 0018 is explicit about why — a count guard
 * would eventually refuse a lawful bulk unlist, blocking a departure from taking effect,
 * which is the platform lying to adopters in the one direction it least tolerates.
 *
 * *ADR 0018's second open measurement is whether 2,500 rows come back in one D1 query or
 * have to be paged. This issues one, which is the shape to measure; a rewrite tolerates a
 * paged read because it reads the truth either way, so the change if paging proves necessary
 * is local to this function.*
 */
export async function readListableAnimals(
  db: Database,
): Promise<ListableRead> {
  const rows = await db
    .select({
      id: animals.id,
      name: animals.name,
      species: animals.species,
      region: animals.region,
      size: animals.size,
      sex: animals.sex,
      estimatedBirthDate: animals.estimatedBirthDate,
      lastConfirmedAt: animals.lastConfirmedAt,
      goodWithChildren: animals.goodWithChildren,
      goodWithDogs: animals.goodWithDogs,
      goodWithCats: animals.goodWithCats,
      availability: animals.availability,
      urgentReason: animals.urgentReason,
      shelterId: animals.shelterId,
      /** `null` where the primary photograph's row has gone — see {@link ListableRead}. */
      sourceDigest: uploadSessionPhotos.sourceDigest,
      contactPointCount,
      latestVerificationOutcome,
    })
    .from(animals)
    /**
     * Inner, because an animal's shelter is a `notNull` foreign key: a row that failed to
     * join would be referential damage rather than an animal to decide about.
     */
    .innerJoin(shelters, eq(shelters.id, animals.shelterId))
    /**
     * Left, because the primary photograph is the one thing here that can legitimately be
     * missing at read time. **Position 0 is the primary** — a fact about the order rather
     * than an `isPrimary` column, and the unique index on `(session_id, position)` is what
     * makes it single-valued, so this join cannot fan a row out into two.
     */
    .leftJoin(
      uploadSessionPhotos,
      and(
        eq(uploadSessionPhotos.sessionId, animals.uploadSessionId),
        eq(uploadSessionPhotos.position, 0),
      ),
    )
    .orderBy(asc(animals.id));

  const showable: (typeof rows[number] & { sourceDigest: string })[] = [];
  let withoutPhoto = 0;

  for (const row of rows) {
    /**
     * `departedAt` is always `null` until Departure lands with issue #65, exactly as
     * `../auth/store.ts`'s `readShelterFacts` records. When that ticket adds the column this
     * grows one more selected field and the rule keeps working unchanged — which is the whole
     * reason the listing rule takes flat facts rather than rows.
     */
    const shelterFacts: ShelterFacts = {
      latestVerificationOutcome: row.latestVerificationOutcome,
      contactPointCount: row.contactPointCount,
      departedAt: null,
    };

    if (!isListed({ availability: row.availability }, shelterFacts)) continue;

    if (row.sourceDigest === null) {
      withoutPhoto += 1;
      continue;
    }

    showable.push({ ...row, sourceDigest: row.sourceDigest });
  }

  /**
   * Every thumbnail key at once rather than one per iteration.
   *
   * Each is a `crypto.subtle.digest`, which is a promise per animal, and awaiting them in
   * sequence would put 2,500 microtask turns end to end for work that has no ordering
   * between its parts. This is the hashing half of ADR 0018's first open measurement — the
   * isolate CPU of serializing and hashing 2,500 rows against the 10 ms ceiling — so doing it
   * the cheap way is the point rather than a flourish.
   */
  const listed = await Promise.all(
    showable.map(async (row): Promise<ListedAnimal> => {
      const goodWith: GoodWithFlags = {
        children: row.goodWithChildren,
        dogs: row.goodWithDogs,
        cats: row.goodWithCats,
      };

      return {
        id: row.id,
        name: row.name,
        species: row.species,
        region: row.region,
        size: row.size,
        sex: row.sex,
        estimatedBirthDate: row.estimatedBirthDate,
        lastConfirmedAt: row.lastConfirmedAt,
        goodWith,
        /**
         * Recomputed rather than read, because `db/` deliberately stores no derivative keys: a
         * key is a hash of the source bytes plus the spec (ADR 0012), so storing it would be
         * storing a derived value that could disagree with the function that derives it.
         *
         * `cardThumbnail` is the derivative the listing card shows — 400px on the long edge,
         * WebP, generated for every photo at upload. The 8.6× photo-payload span #17 measured
         * across card shapes is what makes *which* derivative this is the expensive decision on
         * the page, and it is decided here once for every card.
         */
        thumbnailKey: await derivativeKey(row.sourceDigest, "cardThumbnail"),
        /**
         * Always `null` until bonded groups land with issue #59, which #56 puts out of scope:
         * single animals only. The field is on the wire already because the index's shape is
         * `domain/`'s and the measurement was taken over it, so #59 fills a column in rather
         * than changing a format two consumers agree on.
         */
        bondedGroupId: null,
        /**
         * **The presence of the reason is the mark** — there is no `is_urgent` boolean, because
         * two columns could disagree and `CONTEXT.md` builds the reason into the definition. The
         * card needs only the fact, and the reason stays on the animal page (#17), so the
         * column becomes a boolean exactly here.
         */
        urgent: row.urgentReason !== null,
        shelterId: row.shelterId,
      };
    }),
  );

  return { animals: listed, withoutPhoto };
}
