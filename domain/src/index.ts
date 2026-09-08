/**
 * `domain/` — the pure rules three consumers share: the prerender that builds the listing,
 * the browser island that filters it, and the digest matcher that decides what to send.
 * No I/O, no `db/` import, no clock of its own. Every rule that depends on the time takes
 * `now` as an argument, so nothing here has to be waited for.
 *
 * Why this package is a seam, and how its purity and browser-importability are enforced:
 * [`docs/testing-seams.md`](../../docs/testing-seams.md).
 */

export type { AgeBand } from "./age-band.ts";
export { AGE_BANDS, deriveAgeBand, monthsBetween } from "./age-band.ts";
export type {
  AgeEstimateBasis,
  AnimalDraftFacts,
  AnimalRefusal,
  AnimalRefusalReason,
  SizePairing,
  Sterilisation,
  UrgencyMark,
} from "./animal.ts";
export {
  AGE_ESTIMATE_BASES,
  MAX_URGENT_PER_SHELTER,
  STERILISATIONS,
  isAgeEstimateBasis,
  isSterilisation,
  refuseAnimal,
  refuseSizePairing,
  refuseUrgency,
} from "./animal.ts";
export type {
  GoodWithAxis,
  GoodWithFlag,
  GoodWithFlags,
  Region,
  Sex,
  Size,
  Species,
} from "./axes.ts";
export {
  GOOD_WITH_AXES,
  GOOD_WITH_FLAGS,
  SEXES,
  SIZE_ADULT_KILOGRAMS,
  SIZES,
  SPECIES,
  isGoodWithFlag,
  isSex,
  isSize,
  isSpecies,
  sizeApplies,
} from "./axes.ts";
export {
  CRITERIA_VOCABULARIES,
  MAX_CRITERIA_VALUES_PER_AXIS,
  MAX_REGION_LENGTH,
  normaliseRegion,
  parseCriteria,
  readCriteria,
  writeCriteria,
} from "./criteria.ts";
export type { DerivativeName, DerivativeSpec } from "./derivative.ts";
export {
  DERIVATIVE_CACHE_CONTROL,
  DERIVATIVE_PREFIX,
  DERIVATIVES,
  derivativeContentType,
  derivativeKeyFor,
  derivativeKeyMaterial,
  derivativeSpecFingerprint,
} from "./derivative.ts";
export type { DigestPeriod } from "./digest.ts";
export { DIGEST_DAILY_BUDGET, digestIdempotencyKey } from "./digest.ts";
export type {
  FilterIndex,
  IndexPointer,
  ListedAnimal,
  StoredIndexObject,
} from "./filter-index.ts";
export {
  INDEX_CACHE_CONTROL,
  INDEX_CONTENT_ENCODING,
  INDEX_CONTENT_TYPE,
  INDEX_POINTER_KEY,
  INDEX_PREFIX,
  POINTER_CACHE_CONTROL,
  SUPERSEDED_INDEX_GRACE_MS,
  compareByFreshestConfirmed,
  indexGeneratedAt,
  indexObjectKey,
  isSupersededIndexObject,
  parseIndex,
  selectListed,
  serializeIndex,
} from "./filter-index.ts";
export type {
  AnimalFacts,
  Availability,
  ShelterFacts,
  VerificationOutcome,
} from "./listing.ts";
export { AVAILABILITIES, isAvailability, isListed } from "./listing.ts";
export type {
  AdoptionUnit,
  AnimalAxes,
  BondedGroup,
  SubscriptionCriteria,
} from "./matching.ts";
export { ageBandsFor, goodWithFor, matches } from "./matching.ts";
export {
  OPT_IN_TTL_MS,
  OPT_IN_WINDOW_MS,
  optInMailLedgerCutoff,
  optInPurgeCutoff,
} from "./retention.ts";
export type { StalenessBand } from "./staleness.ts";
export { daysBetween, deriveStalenessBand } from "./staleness.ts";
export type {
  PhotoRole,
  StorageMeasurement,
  StorageMode,
  UploadPreflight,
  UploadRefusal,
  UploadRefusalReason,
  UploadSessionFacts,
} from "./upload.ts";
export {
  ACCEPTED_ORIGINAL_TYPES,
  MAX_ORIGINAL_BYTES,
  MAX_ORIGINAL_DIMENSION,
  MAX_ORIGINAL_PIXELS,
  MAX_PHOTOS_PER_ANIMAL,
  MIN_PHOTOS_PER_ANIMAL,
  MONTHLY_TRANSFORMATION_BUDGET,
  STORAGE_ALARM_BYTES,
  STORAGE_DEGRADE_BYTES,
  STORAGE_MEASUREMENT_MAX_AGE_MS,
  STORAGE_REFUSE_BYTES,
  UPLOAD_SESSION_TTL_MS,
  derivativesFor,
  deriveStorageMode,
  isAbandoned,
  isResumable,
  photoLimitFor,
  refuseImage,
  refuseUpload,
  transformationMonthStart,
  transformationsFor,
  transformationsForAnimal,
} from "./upload.ts";
