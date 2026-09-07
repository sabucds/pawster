/**
 * The listing rule. `CONTEXT.md` defines a Listing as *derived*: "an animal is listed
 * while it is available, its shelter is verified, and that shelter offers at least one
 * contact point", plus the fourth clause [ADR 0015](../../docs/adr/0015-a-shelter-can-leave-but-cannot-be-erased.md)
 * added — the shelter has not left. There is deliberately no `listed` column in `db/`,
 * because a boolean stored beside those four inputs is a second answer that can disagree
 * with them.
 *
 * The rule takes **flat facts rather than rows** so that all three consumers can call it:
 * the prerender reads them out of Drizzle, the digest matcher out of its candidate query,
 * and a shelter's own publishing preview out of a form that has not been saved yet. A
 * signature over `db/` row types would have shut the last two out and put the rule back
 * at each call site.
 */

/**
 * The three animal states, and there are three
 * ([ADR 0015](../../docs/adr/0015-a-shelter-can-leave-but-cannot-be-erased.md)). *Archived*
 * is not a fourth: it is the retained record of an animal that has left the listing, and
 * an archive page reads its shelter's departure to word itself rather than the platform
 * inventing a per-animal state to carry a shelter-level fact.
 */
export type Availability = "Available" | "Adopted" | "NoLongerAvailable";

/**
 * The outcome of one verification entry. Standing is an append-only log
 * ([ADR 0003](../../docs/adr/0003-verification-is-an-append-only-log.md)) and a shelter's
 * current standing is its latest entry, so this is *not* a status column — it is the
 * outcome read off the top of the log.
 *
 * The rule below tests for `Verified` rather than against `Revoked`, which is what lets a
 * later ticket add an outcome without widening the listing by accident.
 */
export type VerificationOutcome = "Verified" | "Revoked";

/** What the listing rule needs to know about an animal. */
export interface AnimalFacts {
  readonly availability: Availability;
}

/** What the listing rule needs to know about the shelter that published it. */
export interface ShelterFacts {
  /**
   * The outcome of the shelter's latest verification entry, or `null` where it has none.
   * `null` is *pending*, which ADR 0003 makes the absence of an entry rather than a
   * stored state — so the absence is spelled as an absence here too.
   */
  readonly latestVerificationOutcome: VerificationOutcome | null;
  /**
   * How many public contact points the shelter offers. A count rather than the points
   * themselves: the rule only asks whether an adopter can reach anyone, and handing a
   * pure function a volunteer's WhatsApp number to not look at is worse than not having
   * it.
   */
  readonly contactPointCount: number;
  /**
   * When the shelter decided to leave, or `null` while it is still here. A Departure
   * delists immediately even though the contact surface survives another thirty days
   * (ADR 0015), so this clause and the contact-point clause are not redundant: for the
   * whole grace window this is the only one that has fired.
   */
  readonly departedAt: Date | null;
}

/**
 * Whether an animal is publicly visible. One expression with four clauses, and no clock:
 * silence never ends a listing ([ADR 0001](../../docs/adr/0001-no-automatic-unlisting.md)),
 * so nothing here can change while nobody acts. Staleness is derived beside this and
 * changes only how an animal is labelled and ordered.
 */
export function isListed(animal: AnimalFacts, shelter: ShelterFacts): boolean {
  return (
    animal.availability === "Available" &&
    shelter.latestVerificationOutcome === "Verified" &&
    shelter.contactPointCount > 0 &&
    shelter.departedAt === null
  );
}
