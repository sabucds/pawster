import {
  animals,
  createDb,
  uploadSessionPhotos,
  uploadSessions,
} from "@pawster/db";
import type { Availability, Sex, Size, Species } from "@pawster/domain";
import { env } from "cloudflare:test";

/**
 * One stored animal, complete, for the suites that need something to render.
 *
 * Extracted for the reason `shelter.ts` gives about the sign-in flow, and issue #55 is what
 * made it true here: an animal became twenty columns, two of them under CHECK constraints and
 * one a foreign key into the upload session its photos live in. Both suites that seed an animal
 * would otherwise carry a copy of that shape, and the copies would drift — the first ticket to
 * add a column would leave one suite compiling and the other not, which is the good case. The
 * bad case is the size pairing: a copy that seeded a cat with a size would fail inside the
 * database with a constraint error, and the suite would report it as whatever it was actually
 * testing.
 *
 * ## Why a session and a photo are written too
 *
 * An animal names the upload session it was assembled from (ADR 0012), so a fixture that
 * inserted only the animal row would either violate the foreign key or point at a session that
 * does not exist. And an animal whose session holds no photographs is a state the publish path
 * refuses to create — `domain/`'s one-to-six invariant — so seeding one without a photo would
 * put the suites to work against an animal that could not exist.
 */

export interface SeedAnimalOptions {
  readonly id?: string;
  readonly shelterId?: string;
  readonly name?: string;
  readonly species?: Species;
  /**
   * Left unset, this follows the species — a size for a dog and `null` for a cat — so a caller
   * that only wanted a cat cannot accidentally write a row the size CHECK refuses. Pass it
   * explicitly to test the pairing itself.
   */
  readonly size?: Size | null;
  readonly sex?: Sex;
  readonly region?: string;
  readonly estimatedBirthDate?: Date;
  readonly lastConfirmedAt?: Date;
  readonly availability?: Availability;
  /** `null` for an animal not carrying the mark, which is the default. */
  readonly urgentReason?: string | null;
  /** How many photos its session holds. One unless a test is about the count. */
  readonly photoCount?: number;
}

export interface SeededAnimal {
  readonly animalId: string;
  readonly sessionId: string;
}

/**
 * One upload session holding `photoCount` photographs, and **no animal**.
 *
 * The state the publishing form is actually reached in: the photographs exist, the animal does
 * not yet (ADR 0012). Exported because the publish suite needs exactly this and building it by
 * hand there would be a second copy of the photo row's ten columns.
 *
 * `photoCount: 0` is a legitimate call — it is the abandoned session whose publish `domain/`
 * refuses — so the loop below is allowed to run zero times.
 */
export async function seedUploadSession(
  shelterId: string,
  photoCount: number,
  sessionId = `session-for-${shelterId}`,
): Promise<string> {
  const db = createDb(env.DB);
  const createdAt = new Date("2026-08-30");

  await db.insert(uploadSessions).values({ id: sessionId, shelterId, createdAt });

  for (let position = 0; position < photoCount; position++) {
    await db.insert(uploadSessionPhotos).values({
      id: `${sessionId}-photo-${position}`,
      sessionId,
      position,
      sourceDigest: `${"0".repeat(63)}${position}`,
      originalKey: `o/${sessionId}/${position}`,
      contentType: "image/jpeg",
      byteSize: 1024,
      width: 1600,
      height: 1200,
      createdAt,
    });
  }

  return sessionId;
}

/** Written directly rather than through the publish route: these suites are not testing publishing. */
export async function seedAnimal(
  options: SeedAnimalOptions = {},
): Promise<SeededAnimal> {
  const db = createDb(env.DB);

  const animalId = options.id ?? "animal-1";
  const shelterId = options.shelterId ?? "shelter-1";
  const species = options.species ?? "dog";
  const size =
    options.size !== undefined
      ? options.size
      : species === "dog"
        ? "Medium"
        : null;
  const createdAt = new Date("2026-08-30");
  const sessionId = await seedUploadSession(
    shelterId,
    options.photoCount ?? 1,
    `session-for-${animalId}`,
  );

  await db.insert(animals).values({
    id: animalId,
    shelterId,
    uploadSessionId: sessionId,
    name: options.name ?? "Canela",
    species,
    size,
    sex: options.sex ?? "Female",
    estimatedBirthDate: options.estimatedBirthDate ?? new Date("2025-01-01"),
    ageEstimateBasis: "ShelterGuess",
    region: options.region ?? "Miranda",
    goodWithChildren: "Yes",
    goodWithDogs: "Yes",
    goodWithCats: "Unknown",
    description: "Cariñosa y tranquila.",
    medicalNeeds: null,
    sterilisation: "Sterilised",
    availability: options.availability ?? "Available",
    lastConfirmedAt: options.lastConfirmedAt ?? new Date("2026-08-30"),
    matchableSince: createdAt,
    urgentReason: options.urgentReason ?? null,
  });

  return { animalId, sessionId };
}

/**
 * Emptied in dependency order, children first, because D1 enforces the foreign keys.
 *
 * Exported beside the seeder so a suite cannot clear the animals and leave their sessions
 * behind — the unique index on `upload_session_id` would then refuse the next seed, and the
 * failure would surface in whichever test happened to run second.
 */
export async function clearAnimalTables(): Promise<void> {
  await env.DB.exec("DELETE FROM animals");
  await env.DB.exec("DELETE FROM upload_session_photos");
  await env.DB.exec("DELETE FROM upload_sessions");
}
