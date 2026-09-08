/**
 * Every query publishing and editing an animal makes, and nothing else.
 *
 * The boundary `../shelter/store.ts` and `../photos/store.ts` each draw for themselves. The
 * photos are the neighbour this file leans on rather than duplicates: {@link countSessionPhotos}
 * is here because it answers a question about *publishing* — how many photographs an animal
 * would be written from — while reading the photos themselves stays in `../photos/store.ts`,
 * which owns their shape.
 *
 * No Drizzle client is built here; every function takes one. `db/src/index.ts` requires the
 * client to be constructed inside the request handler, and a module that built its own would be
 * the exact shape `scripts/check-source-rules.mjs` fails the build over.
 *
 * ## The animal row is written last
 *
 * [ADR 0012](../../../../docs/adr/0012-derivatives-are-generated-once-at-upload.md) puts the
 * animal's insert after its photographs are already stored, and {@link publishAnimal} is where
 * that ordering is finally spent: by the time it runs, the derivatives exist in R2 and the photo
 * rows exist in D1, so the single `INSERT` either produces a complete animal or produces
 * nothing. There is no half-published state to reconcile, and no `Draft` row for a later job to
 * finish — an abandoned session is simply a session with no animal, which is exactly what
 * [ADR 0016](../../../../docs/adr/0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md)
 * has the sweep look for.
 */

import type { Database } from "@pawster/db";
import { animals, uploadSessionPhotos } from "@pawster/db";
import type {
  AgeEstimateBasis,
  Availability,
  GoodWithFlag,
  GoodWithFlags,
  Sex,
  Size,
  Species,
  Sterilisation,
} from "@pawster/domain";
import { and, count, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { AnimalEditInput, AnimalInput } from "./publish.ts";

/**
 * One of a shelter's animals, as its own pages render it.
 *
 * No `ageBand` and no `listed`: both are derived by `domain/` at read time from the columns
 * below, which is why neither is stored and why neither is assembled here. A store that
 * returned a band would be the second place it was computed.
 */
export interface StoredAnimal {
  readonly id: string;
  /** Returned so the endpoint can answer "is this yours" with a 404 rather than a filter. */
  readonly shelterId: string;
  readonly uploadSessionId: string;
  readonly name: string;
  readonly species: Species;
  readonly size: Size | null;
  readonly sex: Sex;
  readonly estimatedBirthDate: Date;
  readonly ageEstimateBasis: AgeEstimateBasis;
  readonly region: string;
  readonly goodWith: GoodWithFlags;
  readonly description: string;
  readonly medicalNeeds: string | null;
  readonly sterilisation: Sterilisation;
  readonly availability: Availability;
  readonly lastConfirmedAt: Date;
  readonly matchableSince: Date;
  readonly urgentReason: string | null;
}

/** The columns every read below selects, named once so the three of them cannot drift. */
const ANIMAL_COLUMNS = {
  id: animals.id,
  shelterId: animals.shelterId,
  uploadSessionId: animals.uploadSessionId,
  name: animals.name,
  species: animals.species,
  size: animals.size,
  sex: animals.sex,
  estimatedBirthDate: animals.estimatedBirthDate,
  ageEstimateBasis: animals.ageEstimateBasis,
  region: animals.region,
  goodWithChildren: animals.goodWithChildren,
  goodWithDogs: animals.goodWithDogs,
  goodWithCats: animals.goodWithCats,
  description: animals.description,
  medicalNeeds: animals.medicalNeeds,
  sterilisation: animals.sterilisation,
  availability: animals.availability,
  lastConfirmedAt: animals.lastConfirmedAt,
  matchableSince: animals.matchableSince,
  urgentReason: animals.urgentReason,
} as const;

/**
 * One animal exactly as the columns above return it: a {@link StoredAnimal} with the three
 * good-with axes still loose. Written as a transformation of `StoredAnimal` rather than as a
 * second field list so the two cannot drift — a column added to the interface has to be
 * accounted for here.
 */
type AnimalRow = Omit<StoredAnimal, "goodWith"> & {
  readonly goodWithChildren: GoodWithFlag;
  readonly goodWithDogs: GoodWithFlag;
  readonly goodWithCats: GoodWithFlag;
};

/**
 * The three good-with columns folded back into one record.
 *
 * Three columns and one object, because the database filters each axis independently while every
 * reader treats them as one fact about the animal — `domain/`'s `GoodWithFlags` is a record over
 * `GOOD_WITH_AXES`, and handing a page three loose fields would let one of them be forgotten by
 * a renderer that iterated the other two.
 */
function toStoredAnimal(row: AnimalRow): StoredAnimal {
  const { goodWithChildren, goodWithDogs, goodWithCats, ...rest } = row;
  return {
    ...rest,
    goodWith: {
      children: goodWithChildren,
      dogs: goodWithDogs,
      cats: goodWithCats,
    },
  };
}

/**
 * How many photographs a session holds.
 *
 * A `COUNT` rather than reading the rows and taking a length, because the only thing the publish
 * decision needs is the number and the rows carry nine columns each. It counts **stored rows**,
 * which is the point `domain/`'s `AnimalDraftFacts` makes: a count of two means two sets of
 * derivatives are in the bucket right now, not that a form claimed two uploads.
 */
export async function countSessionPhotos(
  db: Database,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(uploadSessionPhotos)
    .where(eq(uploadSessionPhotos.sessionId, sessionId));
  return row?.n ?? 0;
}

/**
 * How many of a shelter's animals carry the urgency mark, **excluding one**.
 *
 * `exceptAnimalId` is what makes an edit safe. Counting the animal being saved would refuse a
 * shelter that was merely rewording the reason on its third urgent animal — the cap would fire
 * on a change that adds no mark. On the publish path there is no animal yet, so nothing is
 * excluded and the count is simply the shelter's current marks.
 *
 * `urgent_reason IS NOT NULL` is the whole test, because that column's presence *is* the mark:
 * there is no `is_urgent` boolean that could disagree with it.
 */
export async function countUrgentAnimals(
  db: Database,
  shelterId: string,
  exceptAnimalId?: string,
): Promise<number> {
  const scope =
    exceptAnimalId === undefined
      ? and(eq(animals.shelterId, shelterId), isNotNull(animals.urgentReason))
      : and(
          eq(animals.shelterId, shelterId),
          isNotNull(animals.urgentReason),
          ne(animals.id, exceptAnimalId),
        );

  const [row] = await db.select({ n: count() }).from(animals).where(scope);
  return row?.n ?? 0;
}

/**
 * The animal already written from this session, or `null` if the session is unconsumed.
 *
 * Exists because the unique index on `upload_session_id` is the *last* line of defence and a
 * constraint violation is not an answer a shelter can act on. A double-click, or a back-button
 * resubmit of the publishing form, would otherwise reach D1 and come back as a raw `UNIQUE`
 * failure — a 500 where the honest response is "these photos are already published, here is the
 * animal". The index stays: this makes the invariant *speak*, it does not replace it.
 */
export async function findAnimalIdForSession(
  db: Database,
  uploadSessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: animals.id })
    .from(animals)
    .where(eq(animals.uploadSessionId, uploadSessionId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * One animal by id, or `null`.
 *
 * Not scoped to a shelter, for the reason `findUploadSession` gives: whether the animal belongs
 * to the caller is an authorisation question, answered at the endpoint where the answer can be a
 * 404 next to the `authenticate()` call it depends on — rather than an empty result the caller
 * has to interpret. {@link StoredAnimal.shelterId} is returned so it can be asked.
 */
export async function findAnimal(
  db: Database,
  id: string,
): Promise<StoredAnimal | null> {
  const [row] = await db
    .select(ANIMAL_COLUMNS)
    .from(animals)
    .where(eq(animals.id, id))
    .limit(1);
  return row ? toStoredAnimal(row) : null;
}

/**
 * A shelter's own animals, newest first.
 *
 * Ordered by `matchableSince` rather than by `lastConfirmedAt`, which would reshuffle the list
 * every time the shelter confirmed anything — the page is a stable inventory a shelter learns
 * the shape of, not a feed. Every availability is included: an adopted animal is still the
 * shelter's, and hiding it would look like the row had been lost.
 */
export async function listShelterAnimals(
  db: Database,
  shelterId: string,
): Promise<readonly StoredAnimal[]> {
  const rows = await db
    .select(ANIMAL_COLUMNS)
    .from(animals)
    .where(eq(animals.shelterId, shelterId))
    .orderBy(desc(animals.matchableSince));
  return rows.map(toStoredAnimal);
}

export interface PublishAnimal {
  readonly shelterId: string;
  /** The session whose photographs this animal is being assembled from. */
  readonly uploadSessionId: string;
  readonly animal: AnimalInput;
  readonly now: Date;
}

/**
 * Write the animal, and hand back the id it was given.
 *
 * One `INSERT` and no batch, which is the whole of ADR 0012's payoff: the photographs and their
 * derivatives are already stored, so there is no second row that has to succeed with this one
 * and no window in which half an animal exists.
 *
 * `matchableSince` and `lastConfirmedAt` are both set to `now` and they are not the same fact —
 * they merely coincide at publication. Publishing is the animal entering the pool *and* the
 * shelter asserting the animal is true, so both clocks start together and then diverge: every
 * later edit moves the second and never the first.
 *
 * The id is generated here rather than passed in because it is the animal's whole public address
 * — there is no slug, which is what makes the name freely renameable — and a caller that chose
 * it would be the second place that address was decided.
 */
export async function publishAnimal(
  db: Database,
  request: PublishAnimal,
): Promise<string> {
  const id = crypto.randomUUID();
  const { animal } = request;

  await db.insert(animals).values({
    id,
    shelterId: request.shelterId,
    uploadSessionId: request.uploadSessionId,
    name: animal.name,
    species: animal.species,
    size: animal.size,
    sex: animal.sex,
    estimatedBirthDate: animal.estimatedBirthDate,
    ageEstimateBasis: animal.ageEstimateBasis,
    region: animal.region,
    goodWithChildren: animal.goodWith.children,
    goodWithDogs: animal.goodWith.dogs,
    goodWithCats: animal.goodWith.cats,
    description: animal.description,
    medicalNeeds: animal.medicalNeeds,
    sterilisation: animal.sterilisation,
    availability: "Available",
    lastConfirmedAt: request.now,
    matchableSince: request.now,
    urgentReason: animal.urgentReason,
  });

  return id;
}

/**
 * Save an edit, which is also a Confirmation.
 *
 * **`lastConfirmedAt` moves and `matchableSince` does not**, and the asymmetry is the reason both
 * columns exist. `CONTEXT.md` makes a Confirmation "a shelter's deliberate write to one animal —
 * an edit, a new photo, or an explicit 'still available' click — which records that the animal
 * was true as of that moment", so every edit is one by definition and issue #55 requires it.
 * Touching `matchableSince` would re-announce the animal to every subscriber who has already
 * been shown it, turning a corrected typo into a second notification.
 *
 * `uploadSessionId` is absent from the update, and so is the shelter: an animal belongs to
 * exactly one shelter for life and is assembled from exactly one session, and a write path that
 * *could* change either is one a later bug can. Renaming is the thing that is deliberately free,
 * because the id is the address and no link depends on the name.
 */
export async function editAnimal(
  db: Database,
  animalId: string,
  animal: AnimalEditInput,
  now: Date,
): Promise<void> {
  await db
    .update(animals)
    .set({
      name: animal.name,
      species: animal.species,
      size: animal.size,
      sex: animal.sex,
      estimatedBirthDate: animal.estimatedBirthDate,
      ageEstimateBasis: animal.ageEstimateBasis,
      region: animal.region,
      goodWithChildren: animal.goodWith.children,
      goodWithDogs: animal.goodWith.dogs,
      goodWithCats: animal.goodWith.cats,
      description: animal.description,
      medicalNeeds: animal.medicalNeeds,
      sterilisation: animal.sterilisation,
      availability: animal.availability,
      urgentReason: animal.urgentReason,
      lastConfirmedAt: now,
    })
    .where(eq(animals.id, animalId));
}
