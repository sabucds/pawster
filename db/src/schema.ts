import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The skeleton's schema: enough for one SSR route to read one row from a real D1, and no
 * more. The full model — verification entries, photos, subscriptions, the sent-set — lands
 * with the tickets that need it. What is settled here is the *shape*: this package owns
 * the schema and the migrations, and both Workers bind the same database.
 */

export const shelters = sqliteTable("shelters", {
  id: text("id").primaryKey(),
  /** The shelter's public identity. Survives a Departure — ADR 0015. */
  displayName: text("display_name").notNull(),
  /**
   * The one address the platform writes to, and the shelter's whole credential
   * (ADR 0013). Never published: adopters reach a shelter through its contact points.
   */
  accountEmail: text("account_email").notNull().unique(),
  countryCode: text("country_code").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const animals = sqliteTable(
  "animals",
  {
    id: text("id").primaryKey(),
    /** Published by exactly one shelter and never transferred to another. */
    shelterId: text("shelter_id")
      .notNull()
      .references(() => shelters.id),
    name: text("name").notNull(),
    species: text("species", { enum: ["dog", "cat"] }).notNull(),
    /**
     * Stored with the estimate, never the band: the band is derived at read time so an
     * animal graduates on its own (ADR 0004).
     */
    estimatedBirthDate: integer("estimated_birth_date", {
      mode: "timestamp_ms",
    }).notNull(),
    /** An animal carries its own region; it inherits its country from its shelter. */
    region: text("region").notNull(),
    /**
     * When the shelter last confirmed the animal was true. Staleness is derived from it
     * and never stored, and silence never ends a listing (ADR 0001).
     */
    lastConfirmedAt: integer("last_confirmed_at", {
      mode: "timestamp_ms",
    }).notNull(),
    /**
     * No `listed` column, and this is a deliberate omission rather than a gap. CONTEXT.md
     * defines a Listing as *derived*: "an animal is listed while it is available, its
     * shelter is verified, and that shelter offers at least one contact point." Storing a
     * boolean alongside those three inputs creates a second answer that can disagree with
     * them — which is exactly the drift ADR 0004 avoids for age bands. The three inputs
     * (availability, verification standing, contact points) land with the tickets that own
     * them, and `listed` is computed from them at read time.
     */
  },
  (table) => [index("animals_shelter_idx").on(table.shelterId)],
);

export const subscribers = sqliteTable(
  "subscribers",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    /**
     * Fixed at opt-in and the same every week. A property of the subscriber, not of the
     * schedule — which is what makes a weekly digest seven bounded daily runs (ADR 0009).
     * 0 is Sunday, matching `Date.prototype.getUTCDay`.
     */
    sendDay: integer("send_day").notNull(),
    /** Nothing is ever sent to an address that has not opted in. */
    optedInAt: integer("opted_in_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * When this subscriber last received a digest, or `null` if never. ADR 0009's
     * reporting field, and what makes "a shard that exceeds its budget sends its
     * longest-waiting subscribers" expressible: `ORDER BY last_digest_at ASC` puts NULLs
     * first in SQLite, so whoever has waited longest goes first and the tail rotates
     * instead of starving. It is *not* the source of truth for "new" — that is the
     * per-subscription sent-set, which lands with the matching ticket.
     */
    lastDigestAt: integer("last_digest_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("subscribers_send_day_idx").on(table.sendDay)],
);

export type Shelter = typeof shelters.$inferSelect;
export type Animal = typeof animals.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
