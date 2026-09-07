/**
 * `domain/` — the pure rules three consumers share: the prerender that builds the listing,
 * the browser island that filters it, and the digest matcher that decides what to send.
 * No I/O, no `db/` import, no clock of its own. Every rule that depends on the time takes
 * `now` as an argument, so nothing here has to be waited for.
 *
 * The browser is the consumer that earns this package its seam: no Worker test exercises
 * the island, so testing the module the island imports is the only way to test that code
 * at all. `scripts/check-source-rules.mjs` keeps the purity honest, because a `db/` import
 * here would be just an import and no test would fail.
 */

export type { AgeBand } from "./age-band.ts";
export { deriveAgeBand, monthsBetween } from "./age-band.ts";
export type {
  GoodWith,
  GoodWithAxis,
  Region,
  Sex,
  Size,
  Species,
  Tri,
} from "./axes.ts";
export { GOOD_WITH_AXES } from "./axes.ts";
export type { DerivativeName, DerivativeSpec } from "./derivative.ts";
export { DERIVATIVES } from "./derivative.ts";
export type { DigestPeriod } from "./digest.ts";
export { DIGEST_DAILY_BUDGET, digestIdempotencyKey } from "./digest.ts";
export type {
  AnimalFacts,
  Availability,
  ShelterFacts,
  VerificationOutcome,
} from "./listing.ts";
export { isListed } from "./listing.ts";
export type {
  AdoptionUnit,
  Animal,
  BondedGroup,
  SubscriptionCriteria,
} from "./matching.ts";
export { ageBandsFor, goodWithFor, matches } from "./matching.ts";
export type { StalenessBand } from "./staleness.ts";
export { daysBetween, deriveStalenessBand } from "./staleness.ts";
