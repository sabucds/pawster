import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  /**
   * The shelter's public identity. Survives a Departure — ADR 0015.
   *
   * Editable in a session for as long as the shelter exists, before and after verification
   * (issue #52), which is the counterpart to `slug`'s immutability above: a shelter fixing a
   * typo in its own name must not break the URLs adopters already hold, and holding the two
   * apart is what lets both be true.
   */
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
  /**
   * **No `verified` column and no legal-name column**, and both absences are decisions
   * rather than columns a later ticket adds (issue #52).
   *
   * `verified` is ruled out by ADR 0003: standing is an append-only log and a shelter's
   * current standing is its latest entry, so a boolean beside that log is a second answer
   * that can disagree with it — and one that cannot express *why* a judgement was made,
   * which is the thing the log exists to keep. Pending is the absence of an entry.
   *
   * A legal name is ruled out by having no reader. `displayName` is the public identity and
   * the account email is the credential; a registered charity number or a legal entity name
   * would be evidence for a verification entry, which ADR 0003 already records inside the
   * entry alongside the methods used. A column here would be personal data held on every
   * shelter for the sake of the few whose verification happened to turn on it.
   */
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
    /**
     * Where this point sits in the shelter's own order, counting from 0.
     *
     * **The order is a decision the shelter makes, not a rendering detail.** Position 0 is
     * the channel an adopter is offered as a filled button on an animal's page, so a
     * shelter that answers WhatsApp and merely owns an Instagram account puts WhatsApp
     * first and the hand-off follows. That is the relationship `CONTEXT.md` already gives
     * *Primary Photo* — "a shelter chooses it by ordering, and reordering makes a different
     * photo primary" — and it is why there is no `primary` boolean here: a flag beside an
     * order is a second answer that can disagree with it.
     *
     * Contiguous from 0 by construction rather than by constraint. Every write replaces a
     * shelter's whole set (`web/src/lib/shelter/store.ts`), so no path can leave a gap — and
     * a unique index on `(shelter_id, position)` would refuse the one write that matters,
     * because a reorder that swaps two rows collides on it halfway through.
     */
    position: integer("position").notNull(),
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
     * The upload session whose photos this animal was assembled from.
     *
     * The **only** link between an animal and its photographs, and it points this way
     * because the animal row is written last (ADR 0012): the animal names the session it
     * was built from, and the session never names the animal. Reading an animal's photos is
     * a lookup on `upload_session_photos.session_id` in `position` order with position 0
     * primary — which is why there is no animal-photo table and no `is_primary` column.
     *
     * Unique, because a session is consumed by exactly one animal. Without the constraint a
     * resubmitted form would produce two animals sharing one set of photographs, and each
     * would then be one delete away from having none.
     */
    uploadSessionId: text("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id),
    sex: text("sex", { enum: ["Male", "Female", "Unknown"] }).notNull(),
    /**
     * The expected **adult** size, and `null` for every cat.
     *
     * Dog-only, which the CHECK below states as one equivalence rather than as two rules.
     * The bands are dog weight classes (`domain/`'s `SIZE_ADULT_KILOGRAMS`), so a cat
     * carrying one is a category error rather than a missing feature, and a dog without one
     * has left a filter axis an adopter will actually use unanswered.
     *
     * `null` rather than an `Unspecified` member of the vocabulary, because the vocabulary
     * is shared with the filter panel: a fifth value would be one every dog query had to
     * remember to exclude.
     */
    size: text("size", { enum: ["Small", "Medium", "Large", "Giant"] }),
    /**
     * How `estimatedBirthDate` was arrived at, required alongside it so that a stored date
     * is never rendered as a birthday nobody claimed. `domain/`'s `AGE_ESTIMATE_BASES`.
     */
    ageEstimateBasis: text("age_estimate_basis", {
      enum: ["Documented", "VetEstimate", "ShelterGuess"],
    }).notNull(),
    /**
     * The three good-with axes, each `Yes | No | Unknown`. Three columns rather than one
     * encoded field because each is filtered on independently.
     *
     * `Unknown` is stored and **displayed**, and it costs the shelter no reach: a filter on
     * one axis still shows an animal whose answer is unknown. That is deliberate — were
     * not-known excluded, shelters would learn that claiming `Yes` is the price of being
     * seen, and the flag would stop describing the animal.
     */
    goodWithChildren: text("good_with_children", {
      enum: ["Yes", "No", "Unknown"],
    }).notNull(),
    goodWithDogs: text("good_with_dogs", {
      enum: ["Yes", "No", "Unknown"],
    }).notNull(),
    goodWithCats: text("good_with_cats", {
      enum: ["Yes", "No", "Unknown"],
    }).notNull(),
    /** The shelter's own prose. Bounded by `web/`'s `MAX_DESCRIPTION`, not by the column. */
    description: text("description").notNull(),
    /**
     * Free text, and `null` where there is nothing to say.
     *
     * Deliberately unstructured. A closed vocabulary of conditions would silently drop the
     * one a shelter actually needed to mention, and "leishmaniasis, on treatment until
     * March" is worth more to an adopter than any enum the platform could close.
     */
    medicalNeeds: text("medical_needs"),
    /**
     * Three answers rather than two — `domain/`'s `STERILISATIONS`. A boolean could not say
     * `No se sabe`, which is the honest answer for an animal taken in last week.
     */
    sterilisation: text("sterilisation", {
      enum: ["Sterilised", "NotSterilised", "Unknown"],
    }).notNull(),
    /** One of three, and there is no fourth: no `Draft`, and no persisted `Stale`. */
    availability: text("availability", {
      enum: ["Available", "Adopted", "NoLongerAvailable"],
    }).notNull(),
    /**
     * When the animal first became matchable. Set once at publication and never moved.
     *
     * Distinct from `lastConfirmedAt`, and the pair is the point: a confirmation records
     * that the animal is still true *now*, while this records when it entered the pool. The
     * digest's "what is new" reads this one, so folding the two together would make every
     * edit re-announce an animal that subscribers were shown weeks ago.
     */
    matchableSince: integer("matchable_since", {
      mode: "timestamp_ms",
    }).notNull(),
    /**
     * The written reason for the urgency mark, or `null` for an animal not carrying one.
     *
     * **There is no `is_urgent` boolean; this column's presence is the mark.** Two columns
     * could disagree — urgent with no reason, or a reason with the flag off — and
     * `CONTEXT.md` builds the reason into the definition ("always carrying a written
     * reason"), so a mark without one is not a mark. One column cannot reach that
     * inconsistent state, and `domain/`'s cap of three counts the rows where it is not null.
     */
    urgentReason: text("urgent_reason"),
    /**
     * No `listed` column, and this is a deliberate omission rather than a gap. CONTEXT.md
     * defines a Listing as *derived*: an animal is listed while it is available, its shelter
     * is verified, that shelter offers at least one contact point, and that shelter has not
     * departed. Storing a boolean alongside those four inputs creates a second answer that
     * can disagree with them — which is exactly the drift ADR 0004 avoids for age bands.
     * `availability` above is the one input this table owns; the other three belong to the
     * shelter, and `listed` is computed from all four at read time.
     *
     * No `ageBand` column either, for the same reason and stated by ADR 0004: the band is
     * derived from `estimatedBirthDate` so that an animal graduates on its own.
     */
  },
  (table) => [
    index("animals_shelter_idx").on(table.shelterId),
    uniqueIndex("animals_upload_session_idx").on(table.uploadSessionId),
    /**
     * The dog-only size pairing, as a single equivalence rather than two rules.
     *
     * Here as well as in `domain/`'s `refuseAnimal` because it is **cross-column**, which is
     * the bar a CHECK has to clear in this file: a closed vocabulary is expressed as a
     * Drizzle `enum` and rejected by a `domain/` guard at the parse layer (the convention
     * `shelter_contact_points.kind` and `storage_measurements.mode` already set), so no
     * single-column CHECKs appear above. These two earn theirs by stating facts no column
     * type can carry, and by holding on the paths that bypass the parse layer entirely — a
     * migration, a seed script, a console session.
     */
    check(
      "animals_size_is_dog_only",
      sql`(${table.species} = 'dog') = (${table.size} is not null)`,
    ),
    /**
     * An urgency mark with a blank reason is not a mark. `notNull` cannot say this, because
     * the column is nullable by design — the absence of a reason is the absence of the mark.
     * What has to be impossible is the third state: present but empty.
     */
    check(
      "animals_urgent_reason_not_blank",
      sql`${table.urgentReason} is null or length(trim(${table.urgentReason})) > 0`,
    ),
  ],
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

/**
 * A shelter's in-progress work assembling an animal's photos before the animal exists
 * (`CONTEXT.md`, *Upload Session*).
 *
 * **There is no status column, and its absence is the decision.**
 * [ADR 0016](../../docs/adr/0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md):
 * "an upload session gains no `Abandoned` state and no writer to set one; it is abandoned
 * iff it is older than 24 hours with no committed animal". A stored state would need a
 * writer, and there is none — no code is running at the moment a session dies. So
 * abandonment is derived by `domain/`'s `isAbandoned` from these two columns and the
 * absence of an animal, on the same reasoning that derives age bands and staleness.
 *
 * **There is no reference to an animal here either**, and that direction is deliberate.
 * The animal row is written *last* (ADR 0012), so it is the animal that names the session
 * it was assembled from and never the other way round — a column here would have to be
 * back-filled by the animal's own writer, which is a second write that can fail after the
 * first has succeeded. Issue #55 adds the column on `animals`.
 */
export const uploadSessions = sqliteTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    shelterId: text("shelter_id")
      .notNull()
      .references(() => shelters.id),
    /**
     * The whole clock. Resumable for 24 hours from here, abandoned after — one timestamp,
     * because two (a `createdAt` and an `expiresAt`) would be two facts that can disagree
     * about the same moment.
     */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("upload_sessions_shelter_idx").on(table.shelterId)],
);

/**
 * One accepted photo, staged under a session and belonging to no animal yet.
 *
 * **The derivative keys are absent on purpose.** A derivative's key is a hash of the source
 * bytes plus the spec (ADR 0012), so every key this row implies is recomputable from
 * `sourceDigest` and `position` — storing them would be storing a derived value that could
 * disagree with the function that derives it, which is the drift ADR 0004 avoids for age
 * bands. It also matters to the sweep: reclamation asks "does a live session hold this
 * key", and it can only ask that if the keys come from one place.
 */
export const uploadSessionPhotos = sqliteTable(
  "upload_session_photos",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => uploadSessions.id),
    /**
     * Zero-based, in the order the shelter uploaded. **Position 0 is the primary photo**,
     * which is what makes "the first photo in an animal's order" a fact about the order
     * rather than an `isPrimary` column that could be true of two rows at once.
     *
     * It is also what decides which derivatives this photo has: position 0 carries all
     * four, everything else carries the two that apply to every photo.
     */
    position: integer("position").notNull(),
    /**
     * The SHA-256 of the original's bytes, hex. The `d/` keys are derived from it, so two
     * shelters uploading the same photograph produce one set of objects.
     */
    sourceDigest: text("source_digest").notNull(),
    /**
     * Where the original is in `pawster-originals` until the 7-day lifecycle rule takes
     * it. **Not content-addressed**, unlike the derivatives: the key has to be chosen
     * before the bytes have been read, because the bytes are streamed straight to R2 and
     * the digest only exists once the stream has finished. Two uploads of one photograph
     * therefore store two originals and one set of derivatives, which costs a few
     * megabytes for seven days and saves buffering 12 MB in the isolate.
     */
    originalKey: text("original_key").notNull(),
    /** As the shelter sent it, and one of `domain/`'s `ACCEPTED_ORIGINAL_TYPES`. */
    contentType: text("content_type").notNull(),
    /** The bytes actually stored, counted while streaming — never the declared length. */
    byteSize: integer("byte_size").notNull(),
    /**
     * The image's dimensions **as displayed**, which for a photo carrying a rotation tag
     * is not what its header says: an iPhone writes a 4032x3024 frame and an orientation
     * of 6, and the upright image is 3024x4032. Stored the way an adopter will see it,
     * because that is the only version that will exist once the original expires.
     */
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    /**
     * Unique, which is what makes "position 0 is the primary" a fact the database keeps
     * rather than a convention every writer has to remember. An `isPrimary` column could be
     * true of two rows at once; two rows cannot both be first.
     */
    uniqueIndex("upload_session_photos_session_idx").on(
      table.sessionId,
      table.position,
    ),
    // Reclamation asks whether any live session holds a given source digest.
    index("upload_session_photos_digest_idx").on(table.sourceDigest),
  ],
);

/**
 * The ledger the month's image transformations are spent from.
 *
 * Cloudflare meters 5,000 unique transformations per calendar month against the account and
 * offers no way to read the counter cheaply from a Worker, so the platform keeps its own —
 * and exhaustion is the one failure ADR 0012 will not tolerate discovering late, because
 * error 9422 arrives *mid-upload* and leaves a shelter with a half-built animal.
 *
 * A ledger rather than a counter, for the reason `signInRequests` is one: every limit is
 * then a query over the same rows, with no denormalised total that can disagree with the
 * history it summarises. The grain is one row per photo that actually spent anything, so a
 * month is a `SUM` over a few hundred rows rather than a few thousand.
 *
 * Rows are never deleted by a photo's deletion. A transformation spent is spent, whatever
 * became of what it produced.
 */
export const transformationSpends = sqliteTable(
  "transformation_spends",
  {
    id: text("id").primaryKey(),
    /**
     * How many of the month's 5,000 this spent: four for a primary, two otherwise — and
     * fewer where a derivative already existed, because a content-addressed key that is
     * already in the bucket costs no transformation at all.
     */
    transformations: integer("transformations").notNull(),
    spentAt: integer("spent_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("transformation_spends_spent_at_idx").on(table.spentAt)],
);

/**
 * What ADR 0016's nightly reconciliation measured, and the row the upload path reads to
 * decide how much it may still accept.
 *
 * **Written by issue #66, read here.** Until that job has ever run there is no row, and
 * `domain/`'s `deriveStorageMode` treats its absence exactly as it treats a stale one: it
 * degrades to one photo per animal. That is the cautious direction, and the asymmetry is
 * the argument — degrading costs a shelter five photos it can add later, and trusting a
 * sweep that has died costs the platform a bill it cannot pay.
 *
 * It replaces ADR 0012's animal-count proxy, which "is sound only if every stored byte
 * belongs to an animal that exists" and so was blind by construction to the unreferenced
 * bytes it was meant to catch.
 */
export const storageMeasurements = sqliteTable(
  "storage_measurements",
  {
    id: text("id").primaryKey(),
    /**
     * Actual bytes across **both** buckets. R2's 10 GB is per account, so
     * `pawster-originals` counts — seven days of retained originals is nearer 1 GB than
     * the 0.3 GB ADR 0012 assumed.
     */
    totalBytes: integer("total_bytes").notNull(),
    /**
     * The mode the sweep concluded, for the admin mail and the run summary.
     *
     * **The upload path does not read this**; it derives the mode from `totalBytes` in the
     * same row, so the number and the mode cannot disagree in the direction that matters.
     * Kept because ADR 0016 specifies the row as "measured bytes, timestamp, resulting
     * mode", and because what the sweep *concluded* is the thing an admin needs when
     * asking why a mail arrived.
     */
    mode: text("mode", {
      enum: ["normal", "alarming", "degraded", "refusing"],
    }).notNull(),
    measuredAt: integer("measured_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("storage_measurements_measured_at_idx").on(table.measuredAt)],
);

export type Shelter = typeof shelters.$inferSelect;
export type Animal = typeof animals.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
export type ShelterContactPoint = typeof shelterContactPoints.$inferSelect;
export type ContactPointKind = ShelterContactPoint["kind"];
export type OneTimeCode = typeof oneTimeCodes.$inferSelect;
export type SignInRequest = typeof signInRequests.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type UploadSessionPhoto = typeof uploadSessionPhotos.$inferSelect;
export type TransformationSpend = typeof transformationSpends.$inferSelect;
export type StorageMeasurementRow = typeof storageMeasurements.$inferSelect;
