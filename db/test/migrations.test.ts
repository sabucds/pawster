import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * That migration 0001 applies to a `shelters` table that already holds rows.
 *
 * This exists because drizzle-kit's own output for it did **not**. It generated three
 * `ALTER TABLE shelters ADD <col> NOT NULL` statements with no default, which SQLite accepts
 * only while the table is empty — with a single row present it fails with
 * `Cannot add a NOT NULL column with default value NULL`. Every environment that matters
 * today has an empty `shelters` (issue #67 is the first public deploy), so the generated
 * form would have applied cleanly here and then failed on the first local database anyone
 * had registered a shelter against.
 *
 * The fix is in the SQL: a `DEFAULT ''` on each new column plus an `UPDATE` that moves
 * pre-existing rows onto a unique slug. This test is what keeps that from being flattened
 * back by the next person to run `drizzle-kit generate` and commit the result without
 * reading it — regenerating would restore the plain ALTERs, and this would go red.
 *
 * It applies the migrations **incrementally**, which is what the whole assertion turns on:
 * the suite's own setup file applies all of them at once to an empty database, and that can
 * never observe the failure.
 */

const migrations = env.TEST_MIGRATIONS;

/**
 * Applied here rather than in each test, because the interesting part is a *sequence* — 0000,
 * then a row, then 0001 — and splitting it across tests would make them order-dependent.
 *
 * `env.MIGRATION_DB` is a database of its own, not the one the suite's setup file migrated.
 * `applyD1Migrations` records what it has applied in a `d1_migrations` table, so replaying
 * 0000 against the shared binding would be a no-op and would prove nothing.
 */
beforeAll(async () => {
  await applyD1Migrations(env.MIGRATION_DB, [migrations[0]!]);

  await env.MIGRATION_DB.prepare(
    "INSERT INTO shelters (id, display_name, account_email, country_code, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("legacy-1", "Refugio Anterior", "antes@refugio.example", "VE", 0)
    .run();

  // The statement under test. Before the SQL was corrected by hand, this threw
  // `Cannot add a NOT NULL column with default value NULL` and every test below failed here.
  await applyD1Migrations(env.MIGRATION_DB, [migrations[1]!]);

  /**
   * Two contact points for the same shelter and one for another, inserted while
   * `position` does not exist yet — which is the only state in which 0002's backfill has
   * anything to do. Inserted in the order a registration form would have submitted them.
   */
  await env.MIGRATION_DB.prepare(
    "INSERT INTO shelters (id, slug, display_name, account_email, base_region, country_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind("legacy-2", "legacy-2", "Otro Refugio", "otro@refugio.example", "Zulia", "VE", 0)
    .run();

  for (const [id, shelterId, kind, value] of [
    ["cp-1", "legacy-1", "whatsapp", "+58 412 5550001"],
    ["cp-2", "legacy-1", "instagram", "@refugio"],
    ["cp-3", "legacy-2", "email", "otro@contacto.example"],
  ] as const) {
    await env.MIGRATION_DB.prepare(
      "INSERT INTO shelter_contact_points (id, shelter_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, shelterId, kind, value, 0)
      .run();
  }

  await applyD1Migrations(env.MIGRATION_DB, [migrations[2]!]);
});

describe("migration 0001", () => {
  it("is the migration this test thinks it is", () => {
    // Guards the test's own premise. If a future migration lands, `migrations[1]` stops being
    // 0001 and this file would silently start testing something else.
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations[0]!.name).toContain("0000");
    expect(migrations[1]!.name).toContain("0001");
  });

  it("backfills a row that predates the new columns", async () => {
    const row = await env.MIGRATION_DB.prepare(
      "SELECT slug, base_region, session_epoch FROM shelters WHERE id = ?",
    )
      .bind("legacy-1")
      .first<{ slug: string; base_region: string; session_epoch: number }>();

    // Backfilled to its own id, which is already unique and so satisfies the unique index
    // the migration creates immediately afterwards. Two rows left on `''` would have
    // collided on it.
    expect(row!.slug).toBe("legacy-1");
    expect(row!.base_region).toBe("");
    expect(row!.session_epoch).toBe(0);
  });

  it("leaves the animals foreign key intact", async () => {
    /**
     * The reason the migration adds columns instead of rebuilding the table. A twelve-step
     * rebuild was the other candidate and `DROP TABLE shelters` trips this foreign key — the
     * `PRAGMA defer_foreign_keys` that would suspend it only holds inside a transaction,
     * which a D1 migration does not get.
     */
    const { results } = await env.MIGRATION_DB.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(results).toEqual([]);

    // And the constraint is still enforced, rather than merely unviolated.
    await expect(
      env.MIGRATION_DB.prepare(
        "INSERT INTO animals (id, shelter_id, name, species, estimated_birth_date, region, last_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("orphan", "no-such-shelter", "Canela", "dog", 0, "Miranda", 0)
        .run(),
    ).rejects.toThrow();
  });
});

/**
 * That migration 0002 numbers a pre-existing shelter's contact points **per shelter**, in
 * insertion order, rather than leaving them all on the column default.
 *
 * The same hand-correction 0001 needed, and the same reason for a test: drizzle-kit
 * generated `ADD position integer NOT NULL` with no default, which fails the moment the
 * table holds a row. But `DEFAULT 0` alone would have been a second, quieter bug — every
 * point of a shelter claiming position 0 means three channels each claiming to be the one
 * an adopter is offered, with the tie broken by whatever order SQLite returns. So the
 * assertion here is about the numbering and not merely about the migration applying.
 */
describe("migration 0002", () => {
  it("is the migration this test thinks it is", () => {
    expect(migrations.length).toBeGreaterThanOrEqual(3);
    expect(migrations[2]!.name).toContain("0002");
  });

  it("numbers each shelter's contact points from 0 in insertion order", async () => {
    const { results } = await env.MIGRATION_DB.prepare(
      "SELECT id, shelter_id, position FROM shelter_contact_points ORDER BY shelter_id, position",
    ).all<{ id: string; shelter_id: string; position: number }>();

    expect(results).toEqual([
      { id: "cp-1", shelter_id: "legacy-1", position: 0 },
      { id: "cp-2", shelter_id: "legacy-1", position: 1 },
      // Numbered from 0 again, because the count is scoped to the shelter. A global
      // numbering would have made this 2, leaving the second shelter with nothing at
      // position 0 and so nothing to offer an adopter first.
      { id: "cp-3", shelter_id: "legacy-2", position: 0 },
    ]);
  });
});
