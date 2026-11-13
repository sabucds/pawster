import {
  createExecutionContext,
  createMessageBatch,
  env,
} from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import {
  DEPARTURE_GRACE_MS,
  DIGEST_DELIVERY_TTL_MS,
  SENT_SET_UNLISTED_TTL_MS,
} from "@pawster/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { DigestMessage } from "../src/env.ts";
import worker from "../src/index.ts";

/**
 * The parts of the daily preamble issue #66 adds: the Digest Delivery and sent-set purges,
 * departure destruction, and the reclamation sweep. Each runs through `scheduled()`, the
 * same path the Cron Trigger takes, with `now` injected as the scheduled time.
 */
type ScheduledInvocable = {
  scheduled(options: { scheduledTime: Date | number }): Promise<{ outcome: string }>;
};
const runScheduled = (scheduledTime: Date) =>
  (workerExports.default as unknown as ScheduledInvocable).scheduled({ scheduledTime });

const DAY = 24 * 60 * 60_000;
const NOW = new Date(Date.UTC(2026, 8, 2, 11, 0, 0));

const lastRun = () =>
  env.DB.prepare("SELECT * FROM digest_runs ORDER BY id DESC LIMIT 1").first<
    Record<string, unknown>
  >();

beforeEach(async () => {
  for (const table of [
    "digest_sent",
    "digest_deliveries",
    "digest_runs",
    "subscriptions",
    "subscribers",
    "animals",
    "upload_session_photos",
    "upload_sessions",
    "verifications",
    "shelter_contact_points",
    "shelters",
    "storage_measurements",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
});

describe("departure destruction", () => {
  async function seedDeparted(id: string, departedAt: Date) {
    const at = new Date("2026-01-01").getTime();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO shelters (id, slug, display_name, account_email, base_region, country_code, departed_at, created_at) VALUES (?, ?, ?, ?, 'Miranda', 'VE', ?, ?)",
      ).bind(id, id, `Refugio ${id}`, `${id}@example.org`, departedAt.getTime(), at),
      env.DB.prepare(
        "INSERT INTO shelter_contact_points (id, shelter_id, kind, value, position, created_at) VALUES (?, ?, 'whatsapp', '+58 412 5550001', 0, ?)",
      ).bind(`${id}-cp`, id, at),
    ]);
  }

  const shelter = (id: string) =>
    env.DB.prepare(
      "SELECT display_name, account_email, session_epoch, (SELECT COUNT(*) FROM shelter_contact_points WHERE shelter_id = shelters.id) AS contact_points FROM shelters WHERE id = ?",
    )
      .bind(id)
      .first<{
        display_name: string;
        account_email: string;
        session_epoch: number;
        contact_points: number;
      }>();

  it("destroys contact points and account email and bumps the epoch at day 30, and nothing at day 29", async () => {
    await seedDeparted("day-30", new Date(NOW.getTime() - DEPARTURE_GRACE_MS));
    await seedDeparted("day-29", new Date(NOW.getTime() - DEPARTURE_GRACE_MS + DAY));

    await runScheduled(NOW);

    const gone = await shelter("day-30");
    expect(gone!.contact_points).toBe(0);
    expect(gone!.account_email).not.toContain("day-30@example.org");
    expect(gone!.session_epoch).toBe(1);
    // Everything else about the shelter is kept (ADR 0015).
    expect(gone!.display_name).toBe("Refugio day-30");

    expect(await shelter("day-29")).toEqual({
      display_name: "Refugio day-29",
      account_email: "day-29@example.org",
      session_epoch: 0,
      contact_points: 1,
    });
    expect((await lastRun())!.erased_departures).toBe(1);
  });

  it("bumps the epoch once, not on every run after day 30", async () => {
    await seedDeparted("gone", new Date(NOW.getTime() - DEPARTURE_GRACE_MS));

    await runScheduled(NOW);
    await runScheduled(new Date(NOW.getTime() + DAY));

    expect((await shelter("gone"))!.session_epoch).toBe(1);
    expect((await lastRun())!.erased_departures).toBe(0);
  });
});

async function seedSubscriber(id: string) {
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, send_day, opted_in_at) VALUES (?, ?, 3, ?)",
  )
    .bind(id, `${id}@example.org`, NOW.getTime())
    .run();
}

describe("Digest Delivery", () => {
  it("is written when a digest goes out, keyed on the subscriber and holding no address", async () => {
    await seedSubscriber("s1");
    const batch = createMessageBatch<DigestMessage>("pawster-digest", [
      {
        id: "m1",
        timestamp: NOW,
        attempts: 1,
        body: { period: "2026-09-02", subscriberId: "s1", email: "s1@example.org", sections: [] },
      },
    ]);
    await worker.queue(batch, env, createExecutionContext());

    const { results } = await env.DB.prepare(
      "SELECT subscriber_id, period FROM digest_deliveries",
    ).all();
    expect(results).toEqual([{ subscriber_id: "s1", period: "2026-09-02" }]);
    const { results: columns } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('digest_deliveries')",
    ).all<{ name: string }>();
    expect(columns.map((column) => column.name).sort()).toEqual([
      "id",
      "period",
      "sent_at",
      "subscriber_id",
    ]);
  });

  it("is purged after 90 days and kept until then", async () => {
    await seedSubscriber("s1");
    const insert = env.DB.prepare(
      "INSERT INTO digest_deliveries (id, subscriber_id, period, sent_at) VALUES (?, 's1', '2026-06-01', ?)",
    );
    await env.DB.batch([
      insert.bind("old", NOW.getTime() - DIGEST_DELIVERY_TTL_MS - 1),
      insert.bind("kept", NOW.getTime() - DIGEST_DELIVERY_TTL_MS),
    ]);

    await runScheduled(NOW);

    const { results } = await env.DB.prepare("SELECT id FROM digest_deliveries").all();
    expect(results).toEqual([{ id: "kept" }]);
    expect((await lastRun())!.purged_deliveries).toBe(1);
  });
});

/** A verified shelter with a contact point, and one animal: listed unless told otherwise. */
async function seedListedAnimal(
  id: string,
  availability: "Available" | "Adopted" = "Available",
  photos: { digest: string; position: number }[] = [],
) {
  const at = new Date("2026-01-01").getTime();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO shelters (id, slug, display_name, account_email, base_region, country_code, created_at) VALUES ('shelter-1', 'shelter-1', 'Refugio', 'shelter-1@example.org', 'Miranda', 'VE', ?)",
    ).bind(at),
    env.DB.prepare(
      "INSERT OR IGNORE INTO shelter_contact_points (id, shelter_id, kind, value, position, created_at) VALUES ('cp-1', 'shelter-1', 'whatsapp', '+58 412 5550001', 0, ?)",
    ).bind(at),
    env.DB.prepare(
      "INSERT INTO verifications (shelter_id, outcome, methods, evidence, decided_at, decided_by, cited_display_name, cited_contact_points) SELECT 'shelter-1', 'Verified', 'call', 'seen', ?, 'admin@example.org', 'Refugio', '[]' WHERE NOT EXISTS (SELECT 1 FROM verifications)",
    ).bind(at),
    env.DB.prepare(
      "INSERT INTO upload_sessions (id, shelter_id, created_at) VALUES (?, 'shelter-1', ?)",
    ).bind(`session-${id}`, at),
    ...photos.map((photo) =>
      env.DB.prepare(
        "INSERT INTO upload_session_photos (id, session_id, position, source_digest, original_key, content_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, 'image/jpeg', 1, 1, 1, ?)",
      ).bind(`${id}-${photo.position}`, `session-${id}`, photo.position, photo.digest, `o/${id}-${photo.position}`, at),
    ),
    env.DB.prepare(
      `INSERT INTO animals (id, shelter_id, name, species, estimated_birth_date, region,
        last_confirmed_at, upload_session_id, sex, size, age_estimate_basis, good_with_children,
        good_with_dogs, good_with_cats, description, sterilisation, availability, matchable_since)
       VALUES (?, 'shelter-1', ?, 'dog', ?, 'Miranda', ?, ?, 'Female', 'Medium', 'VetEstimate',
        'Unknown', 'Unknown', 'Unknown', 'A good animal.', 'Unknown', ?, ?)`,
    ).bind(id, `Animal ${id}`, at, at, `session-${id}`, availability, at),
  ]);
}

describe("the sent-set", () => {
  async function seedSent(animalId: string, sentAt: Date) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO subscriptions (id, subscriber_id, slot, criteria, created_at) VALUES ('sub-1', 's1', 0, '{}', 0)",
      ),
      env.DB.prepare(
        "INSERT INTO digest_sent (subscription_id, animal_id, sent_at) VALUES ('sub-1', ?, ?)",
      ).bind(animalId, sentAt.getTime()),
    ]);
  }
  const sentAnimals = async () =>
    (
      await env.DB.prepare("SELECT animal_id FROM digest_sent ORDER BY animal_id").all<{
        animal_id: string;
      }>()
    ).results.map((row) => row.animal_id);

  beforeEach(async () => {
    await seedSubscriber("s1");
  });

  it("keeps a still-listed animal's row however old the send, so it is never re-sent as new", async () => {
    await seedListedAnimal("listed");
    await seedSent("listed", new Date(NOW.getTime() - 400 * DAY));

    await runScheduled(NOW);
    await runScheduled(new Date(NOW.getTime() + 200 * DAY));

    expect(await sentAnimals()).toEqual(["listed"]);
  });

  it("prunes a row 90 days after its animal unlists, and not a moment before", async () => {
    await seedListedAnimal("adopted", "Adopted");
    await seedSent("adopted", new Date(NOW.getTime() - DAY));

    await runScheduled(NOW); // first sees it unlisted
    await runScheduled(new Date(NOW.getTime() + SENT_SET_UNLISTED_TTL_MS));
    expect(await sentAnimals()).toEqual(["adopted"]);

    await runScheduled(new Date(NOW.getTime() + SENT_SET_UNLISTED_TTL_MS + 1));
    expect(await sentAnimals()).toEqual([]);
    expect((await lastRun())!.pruned_sent_rows).toBe(1);
  });

  it("restarts the clock when the animal is listed again", async () => {
    await seedListedAnimal("back", "Adopted");
    await seedSent("back", new Date(NOW.getTime() - DAY));

    await runScheduled(NOW);
    await env.DB.exec("UPDATE animals SET availability = 'Available'");
    await runScheduled(new Date(NOW.getTime() + DAY));
    await runScheduled(new Date(NOW.getTime() + SENT_SET_UNLISTED_TTL_MS + 2 * DAY));

    expect(await sentAnimals()).toEqual(["back"]);
  });
});
