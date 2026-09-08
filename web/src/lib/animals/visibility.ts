/**
 * What the public gets for one animal: the live page, an archive page saying what happened, or
 * nothing at all.
 *
 * `domain/`'s `isListed()` answers one bit — is this animal publicly visible — and that bit is
 * everything the digest and the filter index need. The animal page needs the *other* half:
 * when the answer is no, **which** of the four clauses said so, because `CONTEXT.md` promises
 * an adopter that "its page stays reachable and says what happened" and the three things that
 * happened are worded differently. A page that only had the bit would have to re-derive the
 * cause from the same facts, which is the second answer this codebase keeps refusing to store.
 *
 * ## Why this is in `web/` and not in `domain/`
 *
 * `domain/` is "the pure rules three consumers share", and this is not one: the digest and the
 * browser island both work exclusively in listed animals, so neither has an archive to word.
 * The rule is pure and table-tested all the same, and `visibility.test.ts` asserts the property
 * that keeps the two in step — {@link publicView} returns `listed` for exactly the facts
 * `isListed()` returns `true` for, across the whole cartesian product. A fifth clause added to
 * `isListed()` therefore fails a test here rather than quietly producing an archive page with
 * no wording for it.
 *
 * ## Why an unverified shelter's animal is a 404 and not an archive
 *
 * Three of the four clauses produce an archive page; verification produces nothing, and that
 * asymmetry is the decision worth reading twice.
 *
 * - **Pending or refused** — the animal was never publicly reachable, so there is no promise to
 *   an adopter to keep. Issue #55 made this a 404 precisely so a page cannot leak that the id
 *   is real and the shelter unverified, and an archive page would leak both.
 * - **Revoked** — `CONTEXT.md` is explicit that a Revocation delists a shelter's animals
 *   "**without archiving them**". The platform has withdrawn its judgement about this shelter;
 *   continuing to publish a page under it, even one saying the animal is gone, is the platform
 *   still vouching. It stops.
 *
 * So the archive is a promise to adopters about animals that *were* public, which is exactly
 * how [ADR 0015](../../../../docs/adr/0015-a-shelter-can-leave-but-cannot-be-erased.md) frames
 * it — "the archive is a promise made to adopters rather than to the shelter".
 */

import type { AnimalFacts, ShelterFacts } from "@pawster/domain";

/**
 * Why an animal is no longer listed, in the words the page has to find.
 *
 * Four members for the three clauses that can archive, because `Availability` supplies two of
 * them and they are the two an adopter reads most differently: `Adopted` is the news the
 * platform exists to produce, and `NoLongerAvailable` is everything else that can befall an
 * animal — died, went to another rescue, was reclaimed by an owner — which is why it is worded
 * without a story attached.
 */
export type ArchiveReason =
  /** She found a home. */
  | "Adopted"
  /** The shelter said she is gone, without saying where. */
  | "NoLongerAvailable"
  /** ADR 0015: the shelter left, and took every animal it published out of the listing. */
  | "ShelterDeparted"
  /**
   * The shelter is here, verified, and offers no way to be reached.
   *
   * The clause with no story, and it is here because the alternative is a dead link. It is
   * unreachable through any form — registration and the profile form both refuse an empty
   * contact set, and `writeContactPoints()` throws on one — so in practice it arises only
   * between a Departure and the grace period that destroys the contact surface, where
   * `ShelterDeparted` has already claimed it. It is enumerated anyway because `isListed()` can
   * return `false` for it, and an enumeration with a hole in it is a page that 404s on a state
   * nobody predicted.
   */
  | "ShelterUnreachable";

/**
 * What the public animal route should do. Three cases, and no fourth.
 *
 * A discriminated union rather than a nullable archive reason, because "listed" and "archived
 * because adopted" and "not a public page at all" are three genuinely different renders and a
 * `reason: ArchiveReason | null` beside a boolean would let a caller render an archive page
 * with no reason on it.
 */
export type PublicView =
  | { readonly kind: "listed" }
  | { readonly kind: "archived"; readonly reason: ArchiveReason }
  /** No public page. The route answers 404 and says nothing about why. */
  | { readonly kind: "hidden" };

/**
 * The animal's public view, from exactly the facts `isListed()` is given.
 *
 * The clause order is the order an adopter would want to be told, not the order `isListed()`
 * evaluates in, and one case makes that visible: an animal that was **adopted** from a shelter
 * that has since **left** says she found a home rather than that her shelter is gone. Both are
 * true; only one is the answer to the question the adopter came with. Availability is therefore
 * read before departure.
 */
export function publicView(
  animal: AnimalFacts,
  shelter: ShelterFacts,
): PublicView {
  // Not `!== "Verified"` split across the two negative outcomes, because pending is the absence
  // of an entry (ADR 0003) and all three non-verified states answer the same way.
  if (shelter.latestVerificationOutcome !== "Verified") return { kind: "hidden" };

  if (animal.availability === "Adopted") {
    return { kind: "archived", reason: "Adopted" };
  }
  if (animal.availability === "NoLongerAvailable") {
    return { kind: "archived", reason: "NoLongerAvailable" };
  }
  if (shelter.departedAt !== null) {
    return { kind: "archived", reason: "ShelterDeparted" };
  }
  if (shelter.contactPointCount === 0) {
    return { kind: "archived", reason: "ShelterUnreachable" };
  }

  return { kind: "listed" };
}
