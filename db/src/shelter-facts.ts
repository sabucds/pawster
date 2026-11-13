/**
 * The two shelter-level facts `isListed()` reads, as scalar subqueries over whichever
 * shelter-id column the outer query has: `animals.shelterId` for a listing read,
 * `shelters.id` for a read of shelters. One definition, so the web listing, the digest and the
 * confirmation nudge cannot disagree about which shelters count.
 */

import { type AnyColumn, sql } from "drizzle-orm";
import { shelterContactPoints, verifications } from "./schema.ts";

/**
 * The outcome off the top of the shelter's append-only log
 * ([ADR 0003](../../docs/adr/0003-verification-is-an-append-only-log.md)), or `null` where it
 * has none, which is *pending*.
 *
 * Ordered by the log's `id` and never by `decidedAt`: two decisions in the same millisecond
 * are indistinguishable by the clock, so the clock is not a total order.
 */
export const latestVerificationOutcome = (shelterId: AnyColumn) =>
  sql<(typeof verifications.$inferSelect)["outcome"] | null>`(
    select ${verifications.outcome} from ${verifications}
    where ${verifications.shelterId} = ${shelterId}
    order by ${verifications.id} desc limit 1
  )`;

/**
 * How many public contact points the shelter offers. A count and not the points: the rule
 * only asks whether an adopter can reach anyone.
 */
export const contactPointCount = (shelterId: AnyColumn) =>
  sql<number>`(
    select count(*) from ${shelterContactPoints}
    where ${shelterContactPoints.shelterId} = ${shelterId}
  )`;
