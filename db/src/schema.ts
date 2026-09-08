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
     * Which language this subscriber's digest is written in, captured at opt-in from the
     * page they signed up on.
     *
     * [ADR 0018](../../docs/adr/0018-strings-are-typed-phrase-functions.md): the digest is
     * "the only surface whose locale is a stored per-subscriber fact rather than a property
     * of the URL", because every other surface reads its locale off the route the reader is
     * already on and an email has no route. So it has to be stored, and this is the column.
     *
     * On the subscriber and not on the subscription, even though a subscription is what
     * carries a section of the mail. A subscriber holds up to three and they arrive in one
     * email, so three locales on one document is not a thing that can be rendered; the
     * language belongs to the person reading it.
     */
    locale: text("locale", { enum: ["es", "en"] }).notNull().default("es"),
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
 * One standing set of criteria belonging to a subscriber (`CONTEXT.md`, *Subscription*).
 *
 * **`slot` plus a unique index is what actually refuses a fourth subscription**, and that is
 * the design rather than belt-and-braces. `web/src/lib/subscriber/policy.ts`'s
 * `MAX_SUBSCRIPTIONS_PER_SUBSCRIBER` is a *count read and acted on a moment later*, which is
 * a race by construction — two opt-in links redeemed in the same second both read two and
 * both write a third. A column bounded to 0-2 with at most one row per (subscriber, slot)
 * cannot be raced: the fourth insert has nowhere to go. The constant's job is the *early*
 * refusal, before an opt-in email is spent on a subscription that would be rejected at the
 * end of it.
 *
 * The `CHECK` is half of that and is not decoration. A unique index on `(subscriber_id,
 * slot)` alone bounds nothing — it admits slot 7 — so the cap is the two constraints
 * together, and dropping either silently removes it.
 *
 * A slot is an identity a subscriber's own manage page can name (#62) and is reused after a
 * deletion, which is why it is an assigned small integer rather than a position: a
 * subscriber who deletes their second search and adds another has two searches, not a gap.
 */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    subscriberId: text("subscriber_id")
      .notNull()
      .references(() => subscribers.id),
    /** 0, 1 or 2 — see the table comment. Assigned lowest-free at opt-in. */
    slot: integer("slot").notNull(),
    /**
     * The criteria as `domain/`'s `writeCriteria()` renders it: canonical JSON, keys in axis
     * order, every axis a set.
     *
     * **One JSON column rather than a join table per axis**, and the consumer decides it:
     * `matches()` takes a `SubscriptionCriteria` whole, six axes at once, and every read of
     * this data reads all of it. Six join tables would turn one row into six queries to
     * answer a question nobody asks by axis, and the digest asks it once per subscription
     * per run. `domain/src/criteria.ts` carries the full argument, including why the JSON is
     * canonical as a *string* — two rows then compare with `=`, which the sent-set and the
     * manage page both end up wanting.
     *
     * Never read with `JSON.parse` directly. `readCriteria()` re-runs the parser over it, so
     * a value that was legal when it was written and is not after a vocabulary change cannot
     * reach the matcher.
     */
    criteria: text("criteria").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_slot_idx").on(table.subscriberId, table.slot),
    check("subscriptions_slot_range", sql`${table.slot} between 0 and 2`),
  ],
);

/**
 * A signup that has not been proved yet: an address the platform holds **no consent for at
 * all**, plus the one thing that will become a subscription if the link is followed.
 *
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) sets both of this table's
 * unusual properties, and they are the same decision read from two ends. It is hard-deleted
 * at seven days, because "an unconfirmed opt-in is an address we hold no consent for at all";
 * and **it is the only record in the subscriber model that holds an IP**, because "IP is
 * recorded only on the *unconfirmed* row, where it serves rate limiting, and dies with the
 * seven-day purge. Confirmed subscribers carry no IP at all."
 *
 * That second property is an acceptance criterion of issue #61 rather than a preference, and
 * it is asserted against the live schema in `db/test/migrations.test.ts` — a promise about a
 * column nobody checks is a promise that lapses the first time a ledger looks convenient.
 *
 * A row's existence is what "outstanding" means, so a redeemed opt-in is **deleted** rather
 * than flagged, the way `oneTimeCodes` is. That is what makes the link single-use, and it is
 * why `refuseOptIn()` has no "already used" verdict to return: a used link finds no row.
 */
export const pendingOptIns = sqliteTable(
  "pending_opt_ins",
  {
    /**
     * `HMAC-SHA256(SUBSCRIBER_SECRET, "optin:" || token)`, base64url, and the primary key.
     *
     * Hashed for the reason `oneTimeCodes.codeHash` is: "a plaintext column would hand live
     * login codes to anything that gets query access" (ADR 0013), and a live opt-in link is
     * the same kind of thing — following one writes a subscriber. The token itself is 32
     * random bytes, so unlike a six-digit code it is not searchable and the hash is not
     * standing between an attacker and a guess; what it buys is that a database read is not
     * a set of working links.
     *
     * The primary key rather than a column beside an id, because redemption is a lookup by
     * exactly this value and nothing else ever addresses a row here.
     */
    tokenHash: text("token_hash").primaryKey(),
    /**
     * The address, in plaintext, and the one place in the subscriber model that holds an
     * unconsented one.
     *
     * It cannot be a fingerprint: redemption has to *create a subscriber* with this address
     * and there is no way back from a hash. What bounds the exposure is the seven-day purge
     * rather than the storage form — ADR 0010 derives "every other retention period from
     * what the record is for", and what this record is for ends when the link does.
     */
    email: text("email").notNull(),
    /**
     * The criteria the signup form submitted, already canonicalised by `writeCriteria()`.
     *
     * Stored here rather than re-collected after the click, so following the link is the
     * whole of the subscriber's second visit. The alternative — a form on the opt-in page
     * asking again — turns proof of a mailbox into a second round of checkbox-ticking, and
     * the drop-off would land on the one step nothing works without.
     */
    criteria: text("criteria").notNull(),
    /** Captured here and copied onto the subscriber at redemption — see `subscribers.locale`. */
    locale: text("locale", { enum: ["es", "en"] }).notNull(),
    /**
     * `HMAC-SHA256(SUBSCRIBER_SECRET, "signup-ip:" || address)`, base64url. A fingerprint and
     * not the address, the same posture `signInRequests.ipHash` takes: this column answers
     * "how many signups from this caller in the last hour" and needs nothing else, so it
     * holds the answer rather than the identifier.
     *
     * A hash is still an IP for the purposes of ADR 0010's rule, which is why it lives here
     * and on no other subscriber table.
     */
    ipHash: text("ip_hash").notNull(),
    /**
     * When the mail went out, and **the whole clock**: the link's seven-day expiry is
     * measured from it and the purge cutoff is the same figure read from the other end
     * (`OPT_IN_TTL_MS`). One timestamp rather than a `createdAt` and an `expiresAt`, for the
     * reason `uploadSessions.createdAt` gives — two facts that can disagree about one moment.
     */
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // The per-IP signup limit, and the purge, are both reads over a time range.
    index("pending_opt_ins_ip_idx").on(table.ipHash, table.createdAt),
    index("pending_opt_ins_created_at_idx").on(table.createdAt),
  ],
);

/**
 * One row per opt-in email actually sent: the ledger the global daily ceiling and the
 * per-address cooldown are counted over.
 *
 * **It exists because `pendingOptIns` is deleted on redemption**, and a ceiling counted over
 * rows that disappear when the link is followed is not a ceiling — six sends all redeemed
 * would read as zero and the next six would go out inside the same day. This is the same
 * split `oneTimeCodes` and `signInRequests` already make: one table holds the outstanding
 * credential, another holds the history the limits are spent from.
 *
 * A ledger rather than two counters, for the reason `signInRequests` is one: every limit is
 * then a `SELECT COUNT(*)` over the same rows, with no denormalised total that can disagree
 * with the history it summarises.
 *
 * **It holds no IP and no address**, only a fingerprint of one. The per-IP limit is counted
 * over `pendingOptIns` instead, because ADR 0010 allows exactly one table to hold an IP and
 * that is not this one. `web/src/lib/subscriber/store.ts` records what that costs.
 */
export const optInMails = sqliteTable(
  "opt_in_mails",
  {
    id: text("id").primaryKey(),
    /**
     * `HMAC-SHA256(SUBSCRIBER_SECRET, "subscriber:" || normalised address)`, base64url.
     *
     * A fingerprint because the only question asked of it is "when did we last mail *this*
     * address", which a deterministic digest answers exactly as well as the address would.
     * Unlike `pendingOptIns.email` there is nothing downstream that needs the address back,
     * so holding it would be holding an unconsented address for no reader — which is the
     * thing ADR 0010's "only keep the minimum amount of information needed" rules out.
     */
    emailHash: text("email_hash").notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // The global ceiling reads a time range; the cooldown reads one address inside one.
    index("opt_in_mails_sent_at_idx").on(table.sentAt),
    index("opt_in_mails_email_idx").on(table.emailHash, table.sentAt),
  ],
);

/**
 * A one-way fingerprint of an address that reported us as spam, kept forever so the signup
 * form can refuse it (`CONTEXT.md`, *Do-Not-Contact*).
 *
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) is the whole of this table,
 * and its central point is that the digest is an **HMAC and not a hash**: matching requires
 * deterministic digests, which rules out per-record salting, and "email address space is
 * small enough to enumerate, so a bare `sha256(address)` protects nobody". The remedy the
 * ICO gives is a pepper "stored separately from hashes in a secure environment", which is
 * precisely a keyed MAC — `DO_NOT_CONTACT_PEPPER`, and it is a secret of its own rather than
 * a domain-separated use of `SUBSCRIBER_SECRET` because the two fail in opposite directions.
 * See `web/src/lib/subscriber/crypto.ts`.
 *
 * The residue of a Retirement that outlives the subscriber it belonged to: it answers whether
 * an address is refused and nothing else, because it holds no address to read. There is
 * "no automatic right for people to have their information on such a list deleted", so
 * nothing purges it.
 */
export const doNotContact = sqliteTable("do_not_contact", {
  /**
   * `HMAC-SHA256(DO_NOT_CONTACT_PEPPER, "dnc:" || normalised address)`, base64url.
   *
   * The primary key, which is the lookup: the signup form computes the same digest over what
   * was typed and refuses on a match — silently, because the refusal is a fact about the
   * address and saying it out loud is the enumeration oracle the whole signup path is built
   * to close.
   */
  digest: text("digest").primaryKey(),
  /**
   * Why the entry exists. ADR 0010 keeps "a reason and a date" and nothing else.
   *
   * `complaint` is the only real one, and deliberately: a hard bounce is self-healing —
   * opt-in completes only if the mailbox works — and Resend re-suppresses bounces
   * account-wide anyway, so a bounce earns no entry here.
   *
   * `canary` is not an address at all. ADR 0010 requires that a wrong or lost pepper "fails
   * loudly and immediately" rather than silently matching nobody, and this is where that
   * check is kept: one entry over a fixed string, compared on every signup. It shares the
   * table because the check is then the same point lookup as the refusal itself, and because
   * a second table holding one row is a worse answer than a second reason. Its subject is
   * `canary@pawster.invalid`, in a TLD reserved by RFC 2606, so nobody can type it.
   */
  reason: text("reason", { enum: ["complaint", "canary"] }).notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
});

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
export type Subscription = typeof subscriptions.$inferSelect;
export type PendingOptIn = typeof pendingOptIns.$inferSelect;
export type OptInMail = typeof optInMails.$inferSelect;
export type DoNotContactEntry = typeof doNotContact.$inferSelect;
export type ShelterContactPoint = typeof shelterContactPoints.$inferSelect;
export type ContactPointKind = ShelterContactPoint["kind"];
export type OneTimeCode = typeof oneTimeCodes.$inferSelect;
export type SignInRequest = typeof signInRequests.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type UploadSessionPhoto = typeof uploadSessionPhotos.$inferSelect;
export type TransformationSpend = typeof transformationSpends.$inferSelect;
export type StorageMeasurementRow = typeof storageMeasurements.$inferSelect;
