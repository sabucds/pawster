import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The skeleton's schema plus shelter access. The rest of the model — verification entries,
 * photos, subscriptions, the sent-set — lands with the tickets that need it. What is
 * settled here is the *shape*: this package owns the schema and the migrations, and both
 * Workers bind the same database.
 *
 * Two absences in the access tables below are load-bearing rather than unfinished, and
 * both come from [ADR 0013](../../docs/adr/0013-shelters-sign-in-with-an-emailed-code.md):
 *
 * - **There is no session table.** A Session is a signed cookie carrying the shelter id, an
 *   issued-at and a session epoch, validated against `shelters.sessionEpoch`. Sliding
 *   refresh re-issues the cookie and writes nothing here, so a 90-day sliding session costs
 *   zero rows and zero writes per request.
 * - **There is no verification table yet, and pending is its absence.** ADR 0003 makes
 *   standing an append-only log whose latest entry is the current standing, so a shelter
 *   with no entries is awaiting verification. Registration therefore writes *no*
 *   verification row — and it does not need the table to exist in order to not write to
 *   it. Issue #53 adds the log.
 */

export const shelters = sqliteTable("shelters", {
  id: text("id").primaryKey(),
  /**
   * The shelter's stable public identifier in a URL, generated once at registration from
   * the display name and **never rewritten afterwards** — not when the display name
   * changes, and not when a departed shelter registers afresh.
   *
   * Immutable because a slug is an address adopters and search engines already hold. ADR
   * 0015 keeps a departed shelter's archive pages reachable "because the archive is a
   * promise made to adopters rather than to the shelter", and a slug that followed the
   * display name would break every one of those URLs the first time a shelter fixed a typo
   * in its own name. The display name is the thing that is allowed to change (issue #52);
   * this is not, and holding them apart is why both can exist.
   *
   * Nothing in SQLite enforces immutability, so the enforcement is narrower and worth
   * stating: no query outside registration writes this column.
   */
  slug: text("slug").notNull().unique(),
  /** The shelter's public identity. Survives a Departure — ADR 0015. */
  displayName: text("display_name").notNull(),
  /**
   * The one address the platform writes to, and the shelter's whole credential
   * (ADR 0013). Never published: adopters reach a shelter through its contact points.
   */
  accountEmail: text("account_email").notNull().unique(),
  /**
   * Where the shelter itself is based, which is deliberately *not* where each of its
   * animals is: an animal carries its own region because a shelter may foster far from its
   * base (`CONTEXT.md`, *Region*). This is the default a publishing form offers, never the
   * answer it forces.
   */
  baseRegion: text("base_region").notNull(),
  countryCode: text("country_code").notNull(),
  /**
   * The generation counter every Session cookie is validated against (ADR 0013).
   * **Bumping this integer invalidates every live cookie at once**, and that is the whole
   * revocation mechanism: there is no session table to delete from and no list of active
   * sessions to walk.
   *
   * An authenticated request reads this row anyway to render the publishing area, so the
   * check costs nothing extra. Changing the account email bumps it, extending ADR 0008's
   * rule that an email change invalidates every outstanding link.
   */
  sessionEpoch: integer("session_epoch").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * The public channels an adopter reaches a shelter through — "WhatsApp, Instagram, email or
 * phone" (`CONTEXT.md`, *Contact Point*). A table rather than four nullable columns on
 * `shelters`, because the listing rule asks *how many* there are and a shelter may hold two
 * WhatsApp numbers or no Instagram at all.
 *
 * Registration requires at least one, and that requirement is not paperwork:
 * `domain/`'s `isListed()` has a `contactPointCount > 0` clause, so an animal published by
 * a shelter with none would be invisible for a reason the shelter has no way to see. The
 * cheapest place to make that impossible is the form that creates the shelter.
 *
 * Distinct from the account email, which is auth identity and is never published — so an
 * `email` contact point here and `shelters.accountEmail` are two different facts that may
 * hold the same string, and only one of them is ever rendered.
 */
export const shelterContactPoints = sqliteTable(
  "shelter_contact_points",
  {
    id: text("id").primaryKey(),
    shelterId: text("shelter_id")
      .notNull()
      .references(() => shelters.id),
    /**
     * Typed rather than free text, because each kind is rendered as a different hand-off:
     * WhatsApp becomes a `wa.me` link with a prefilled message, Instagram a profile URL,
     * phone a `tel:` link. A free-text "contact details" blob could not be any of those.
     */
    kind: text("kind", {
      enum: ["whatsapp", "instagram", "email", "phone"],
    }).notNull(),
    /** As the shelter typed it. Shelter-authored text is never translated (ADR 0018). */
    value: text("value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("shelter_contact_points_shelter_idx").on(table.shelterId)],
);

/**
 * The one outstanding One-Time Code, if there is one.
 *
 * **`shelterId` is the primary key, and that is the design rather than a shortcut.** ADR
 * 0013 requires "one outstanding code per shelter, a new request retiring the previous
 * one". Expressed as a primary key, supersession is an upsert and retirement is not a
 * separate act that some code path could forget: writing the new code *is* destroying the
 * old one, atomically, with no window in which two codes are live. A table keyed by its own
 * id would have needed a delete-then-insert and a rule nobody enforces.
 *
 * A row's existence is what "outstanding" means, so a consumed code is deleted rather than
 * flagged. Expired and abandoned rows are cleared by the daily purge ADR 0010 already runs
 * (issue #66); nothing here needs a job of its own.
 */
export const oneTimeCodes = sqliteTable("one_time_codes", {
  shelterId: text("shelter_id")
    .primaryKey()
    .references(() => shelters.id),
  /**
   * `HMAC-SHA256(SIGN_IN_SECRET, "code:" || shelterId || ":" || code)`, base64url.
   *
   * Hashed because "a plaintext column would hand live login codes to anything that gets
   * query access" (ADR 0013) — and a six-digit code is small enough that this is the
   * *whole* protection: an unkeyed SHA-256 of six digits is a million-entry rainbow table,
   * which is why the primitive is a keyed HMAC and the key is a Worker secret that never
   * enters the database. The same primitive ADR 0010 chose for Do-Not-Contact.
   *
   * The shelter id is inside the message so a hash lifted from one row cannot be replayed
   * against another.
   */
  codeHash: text("code_hash").notNull(),
  /**
   * The opaque handle the browser holds while it waits for the code, 32 random bytes as
   * base64url. It is what the code-entry form posts alongside the typed code, and it exists
   * so that **the address never has to travel with the request**.
   *
   * That is a requirement rather than a nicety. ADR 0013 forbids the code-request form from
   * revealing whether an address is registered, so its response has to be identical either
   * way — and a response carrying the submitted address in a redirect URL, a hidden input
   * or a signed cookie is a response whose bytes vary with the address. A fixed-length
   * random token does not: for an unregistered address the platform mints one and stores
   * nothing, and the two responses are byte-identical.
   *
   * Unguessable rather than merely unique, because possession of it plus six digits is a
   * session: 32 bytes puts brute-forcing it out of reach, and the five-attempt ceiling
   * below bounds guessing the code once you hold one.
   */
  requestToken: text("request_token").notNull().unique(),
  /** Ten minutes after issue (ADR 0013). Checked against the request clock, never a job. */
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  /**
   * Wrong guesses so far. At five the code is dead — ADR 0013's ceiling, and what keeps a
   * six-digit secret worth having: five tries against a million codes is a 1-in-200,000
   * chance, and a sixth request costs the attacker a new code they cannot read.
   */
  attemptsUsed: integer("attempts_used").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One row per code request: the ledger the mail budget is spent from.
 *
 * ADR 0013 allocates sign-in mail rather than serving it first-come — "roughly 20 sign-in
 * sends a day", one code per address per five minutes, a per-address daily cap and an IP
 * limit — because the code-request form is unauthenticated by necessity and unbounded
 * priority would let anyone drain the digest's share of Resend's 100/day.
 *
 * **It is a ledger and not four counters** so that every one of those four limits is a
 * `SELECT COUNT(*)` over the same rows, with no denormalised total that can disagree with
 * the history it summarises. Cleared by the daily purge (issue #66).
 */
export const signInRequests = sqliteTable(
  "sign_in_requests",
  {
    id: text("id").primaryKey(),
    /**
     * The shelter the submitted address resolved to, or `null` where it resolved to nobody.
     *
     * `null` is recorded rather than dropped because the row is written before the outcome
     * is known, and because *not* writing it for an unregistered address would make the
     * table's row count a shelter-enumeration oracle for anyone who can read it.
     */
    shelterId: text("shelter_id").references(() => shelters.id),
    /**
     * `HMAC-SHA256(SIGN_IN_SECRET, "ip:" || address)`, base64url. A fingerprint and not the
     * address: this table answers "how many requests from this caller" and needs nothing
     * else, so ADR 0010's posture on Do-Not-Contact applies here too — hold the answer, not
     * the identifier.
     */
    ipHash: text("ip_hash").notNull(),
    /**
     * Whether this request actually spent one of Resend's emails.
     *
     * The distinction the three address-scoped limits turn on. A request for an unregistered
     * address, or one refused by a cap, costs no mail and so must not consume anyone's
     * allowance — otherwise an attacker could lock a shelter out by requesting codes for it,
     * which is the denial-of-service the caps exist to prevent rather than to enable.
     */
    mailSent: integer("mail_sent", { mode: "boolean" }).notNull(),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // The global ceiling and the per-address windows are all reads over a time range.
    index("sign_in_requests_requested_at_idx").on(table.requestedAt),
    index("sign_in_requests_ip_idx").on(table.ipHash, table.requestedAt),
    index("sign_in_requests_shelter_idx").on(
      table.shelterId,
      table.requestedAt,
    ),
  ],
);

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
export type ShelterContactPoint = typeof shelterContactPoints.$inferSelect;
export type ContactPointKind = ShelterContactPoint["kind"];
export type OneTimeCode = typeof oneTimeCodes.$inferSelect;
export type SignInRequest = typeof signInRequests.$inferSelect;
