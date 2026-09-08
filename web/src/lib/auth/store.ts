/**
 * Every query shelter access makes, and nothing else.
 *
 * The queries live apart from the endpoints that call them for one concrete reason: the
 * mail allocation is four limits counted over one ledger, and keeping the counting in one
 * file is what lets `refuseMail()` stay a pure function with a table test. An endpoint that
 * assembled its own `COUNT(*)`s would have put the policy back at the call site.
 *
 * No Drizzle client is built here — every function takes one. `db/src/index.ts` requires the
 * client to be constructed inside the request handler, and a module that built its own
 * would be the exact shape `scripts/check-source-rules.mjs` fails the build over.
 */

import type { Database } from "@pawster/db";
import {
  oneTimeCodes,
  shelterContactPoints,
  shelters,
  signInRequests,
} from "@pawster/db";
import type { ContactPointKind, OneTimeCode } from "@pawster/db";
import type { ShelterFacts } from "@pawster/domain";
import { and, count, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { slugCandidates } from "../slug.ts";
import { generateOneTimeCode, generateRequestToken, hashOneTimeCode } from "./crypto.ts";
import type { MailBudgetUsage } from "./policy.ts";
import {
  ONE_TIME_CODE_MAX_ATTEMPTS,
  ONE_TIME_CODE_TTL_MS,
  ipWindowStart,
  mailBudgetWindowStart,
} from "./policy.ts";

export interface ContactPointInput {
  readonly kind: ContactPointKind;
  readonly value: string;
}

export interface RegistrationInput {
  readonly displayName: string;
  readonly accountEmail: string;
  readonly baseRegion: string;
  readonly countryCode: string;
  /** At least one, enforced before this is built — see `registration.ts`. */
  readonly contactPoints: readonly ContactPointInput[];
}

export interface RegisteredShelter {
  readonly id: string;
  readonly slug: string;
}

/**
 * How many slug candidates to try before giving up.
 *
 * A bound rather than an unbounded loop over an infinite generator, because the generator
 * never terminates by design and a bug in the taken-slug query would otherwise spin the
 * request until the CPU limit killed it. A hundred shelters sharing one display name is not
 * a case worth serving; it is a case worth failing loudly.
 */
const MAX_SLUG_ATTEMPTS = 100;

/**
 * Create a shelter, its contact points, and **no verification row**.
 *
 * That last absence is the ticket's first acceptance criterion and it is satisfied by not
 * writing rather than by writing something: ADR 0003 makes standing an append-only log
 * whose latest entry is the current standing, so "awaiting verification" is the absence of
 * any entry. There is no pending state to set, which is why this function has no line
 * about verification in it at all.
 *
 * The shelter has full publishing access from this moment. Nothing of its is publicly
 * visible, because `isListed()` requires a `Verified` outcome and there is none — the same
 * one rule, not a second switch this function has to remember to leave off.
 */
export async function registerShelter(
  db: Database,
  input: RegistrationInput,
  now: Date,
): Promise<RegisteredShelter> {
  const id = crypto.randomUUID();
  const slug = await reserveSlug(db, input.displayName);

  await db.insert(shelters).values({
    id,
    slug,
    displayName: input.displayName,
    accountEmail: input.accountEmail,
    baseRegion: input.baseRegion,
    countryCode: input.countryCode,
    // `sessionEpoch` is left to its column default of 0. Spelling it here would imply the
    // caller gets a say in it, and no caller does — it is only ever bumped, never set.
    createdAt: now,
  });

  await db.insert(shelterContactPoints).values(
    input.contactPoints.map((point) => ({
      id: crypto.randomUUID(),
      shelterId: id,
      kind: point.kind,
      value: point.value,
      createdAt: now,
    })),
  );

  return { id, slug };
}

/**
 * Pick the first free slug for a display name.
 *
 * One query for every slug already sharing the stem, then a choice made in memory — rather
 * than a round trip per candidate, which would cost a query per collision on the one write
 * path where the shelter is watching a form spinner.
 *
 * This is a read followed by a write and so is racy in principle: two shelters registering
 * the same name in the same instant can both read the same free slug. The unique index on
 * `shelters.slug` is the actual guarantee and the loser gets a failed insert. That is the
 * right trade at roughly forty shelters in the platform's lifetime — the alternative is
 * serialising registration behind a lock to prevent a collision that has never happened.
 */
async function reserveSlug(db: Database, displayName: string): Promise<string> {
  const candidates = slugCandidates(displayName);
  const first = candidates.next();
  // The generator is infinite, so this only happens if it is replaced by one that is not.
  if (first.done) throw new Error("slug generation produced no candidates");
  const stem = first.value;

  const rows = await db
    .select({ slug: shelters.slug })
    .from(shelters)
    // `LIKE 'stem-%'` catches the numbered forms. It also catches an unrelated shelter
    // whose own stem happens to extend this one — `refugio-los-teques-viejo` while we are
    // placing `refugio-los-teques`. Including it is harmless: it can only make us skip a
    // number, never hand out a slug that is taken.
    .where(or(eq(shelters.slug, stem), like(shelters.slug, `${stem}-%`)));

  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(stem)) return stem;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const next = candidates.next();
    if (next.done) break;
    if (!taken.has(next.value)) return next.value;
  }

  throw new Error(
    `no free slug for "${displayName}" after ${MAX_SLUG_ATTEMPTS} candidates`,
  );
}

export interface ShelterIdentity {
  readonly id: string;
  readonly sessionEpoch: number;
}

/**
 * The shelter holding this account email, or `null`.
 *
 * The address is lower-cased before the lookup because the column is unique and a shelter
 * typing `Hola@Refugio.example` into the sign-in form means the same inbox it registered
 * with. Registration lower-cases too, so the two agree — the normalisation is in
 * `registration.ts` where both paths reach it.
 */
export async function findShelterByEmail(
  db: Database,
  accountEmail: string,
): Promise<ShelterIdentity | null> {
  const [row] = await db
    .select({ id: shelters.id, sessionEpoch: shelters.sessionEpoch })
    .from(shelters)
    .where(eq(shelters.accountEmail, accountEmail))
    .limit(1);
  return row ?? null;
}

export async function findShelterEpoch(
  db: Database,
  shelterId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ sessionEpoch: shelters.sessionEpoch })
    .from(shelters)
    .where(eq(shelters.id, shelterId))
    .limit(1);
  return row?.sessionEpoch ?? null;
}

export interface IssuedCode {
  /** The plaintext, which exists only in this process and in the email. */
  readonly code: string;
  readonly requestToken: string;
  readonly expiresAt: Date;
}

/**
 * Issue a code, retiring whatever the shelter had outstanding.
 *
 * The retirement is the `onConflictDoUpdate`, not a separate delete: `oneTimeCodes` is keyed
 * by `shelterId`, so writing the new code *is* destroying the old one, atomically, with no
 * window in which two are live. `attemptsUsed` is reset to 0 explicitly — inherited from the
 * superseded row it would let five wrong guesses against a dead code kill a fresh one.
 *
 * The plaintext is returned and never stored. Only the keyed hash reaches the column.
 */
export async function issueOneTimeCode(
  db: Database,
  secret: string,
  shelterId: string,
  now: Date,
): Promise<IssuedCode> {
  const code = generateOneTimeCode();
  const requestToken = generateRequestToken();
  const expiresAt = new Date(now.getTime() + ONE_TIME_CODE_TTL_MS);
  const codeHash = await hashOneTimeCode(secret, shelterId, code);

  await db
    .insert(oneTimeCodes)
    .values({
      shelterId,
      codeHash,
      requestToken,
      expiresAt,
      attemptsUsed: 0,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: oneTimeCodes.shelterId,
      set: { codeHash, requestToken, expiresAt, attemptsUsed: 0, createdAt: now },
    });

  return { code, requestToken, expiresAt };
}

/**
 * The outstanding code this request token names, or `null`.
 *
 * `null` covers three cases the caller must not tell apart: the token was minted for an
 * address that belongs to nobody, the code was already consumed, or the token is invented.
 * All three are "wrong code" to the shelter, which is what keeps the code form from
 * answering questions about who is registered.
 */
export async function findCodeByRequestToken(
  db: Database,
  requestToken: string,
): Promise<OneTimeCode | null> {
  const [row] = await db
    .select()
    .from(oneTimeCodes)
    .where(eq(oneTimeCodes.requestToken, requestToken))
    .limit(1);
  return row ?? null;
}

/**
 * Count a wrong guess. Returns the new total, so the caller can see the fifth one land.
 *
 * **Incremented in SQL and read back with `RETURNING`, not computed in the Worker.** The
 * obvious form — take the `attemptsUsed` the caller already read, add one, write it — is a
 * lost update, and it is a lost update on the counter that is the entire protection around a
 * six-digit secret. Five requests arriving together all read 0, all write 1, and the code
 * survives to be guessed at again; `policy.ts`'s "five tries against a million codes" stops
 * being true, and nothing else on this path is rate-limited to notice. Sign-in mail is
 * capped, but *guessing* costs no mail at all — an attacker holding one handle can post to
 * the code endpoint as fast as it likes.
 *
 * `attempts_used = attempts_used + 1` is evaluated by SQLite, which serialises writes to the
 * row, so N concurrent guesses produce N increments however they interleave.
 */
export async function recordFailedAttempt(
  db: Database,
  shelterId: string,
): Promise<number> {
  const [row] = await db
    .update(oneTimeCodes)
    .set({ attemptsUsed: sql`${oneTimeCodes.attemptsUsed} + 1` })
    .where(eq(oneTimeCodes.shelterId, shelterId))
    .returning({ attemptsUsed: oneTimeCodes.attemptsUsed });

  /**
   * A missing row means a concurrent request consumed or retired the code between the read
   * and this write. Reporting the ceiling is the safe direction: the caller's next move is to
   * treat the code as finished, which it is.
   */
  return row?.attemptsUsed ?? ONE_TIME_CODE_MAX_ATTEMPTS;
}

/**
 * Retire a code by deleting it.
 *
 * Single use is expressed as absence rather than as a `consumedAt` flag, because a row's
 * existence is already what "outstanding" means — a second meaning for an existing row is a
 * second thing that can disagree. Called on success *and* on the fifth wrong guess: both
 * end the code, and the shelter's next move is the same either way.
 */
export async function deleteOneTimeCode(
  db: Database,
  shelterId: string,
): Promise<void> {
  await db.delete(oneTimeCodes).where(eq(oneTimeCodes.shelterId, shelterId));
}

/**
 * What the ledger says about this shelter's claim on the mail budget.
 *
 * Only rows that actually spent an email count. A request for an unregistered address, or
 * one a cap refused, must not consume anyone's allowance — otherwise requesting codes *for*
 * a shelter would lock it out, which is the denial of service the caps exist to prevent.
 *
 * `shelterId` is `null` when the submitted address resolved to nobody. The global count is
 * still read in that case, and the per-address figures are reported as zero: there is no
 * address to have an allowance. The caller then discards the whole decision, because it has
 * nowhere to send mail — but it does the read anyway, so that the work done for a
 * registered and an unregistered address is the same shape.
 */
export async function readMailBudgetUsage(
  db: Database,
  shelterId: string | null,
  now: Date,
): Promise<MailBudgetUsage> {
  const windowStart = mailBudgetWindowStart(now);
  const sent = eq(signInRequests.mailSent, true);

  const [global] = await db
    .select({ n: count() })
    .from(signInRequests)
    .where(and(sent, gte(signInRequests.requestedAt, windowStart)));

  if (shelterId === null) {
    return {
      globalSendsInWindow: global?.n ?? 0,
      addressSendsInWindow: 0,
      lastAddressSendAt: null,
    };
  }

  const forShelter = and(sent, eq(signInRequests.shelterId, shelterId));

  const [address] = await db
    .select({ n: count() })
    .from(signInRequests)
    .where(and(forShelter, gte(signInRequests.requestedAt, windowStart)));

  /**
   * The most recent send to this address, read without a time bound. The cooldown is five
   * minutes and the window above is a day, so bounding this by the window would be
   * harmless — but it would also be a second place the two constants have to agree, and
   * `MAX(requested_at)` over an indexed column costs the same either way.
   */
  const [last] = await db
    .select({ at: signInRequests.requestedAt })
    .from(signInRequests)
    .where(forShelter)
    .orderBy(desc(signInRequests.requestedAt))
    .limit(1);

  return {
    globalSendsInWindow: global?.n ?? 0,
    addressSendsInWindow: address?.n ?? 0,
    lastAddressSendAt: last?.at ?? null,
  };
}

/**
 * Requests from this caller inside the IP window, sent or not.
 *
 * The one limit counted over requests rather than sends, and the only one that sees a caller
 * submitting addresses that resolve to nobody. It is read *before* the ledger row is
 * written, so a caller already over the limit adds no further rows — which is what bounds
 * the writes an unauthenticated endpoint can be made to perform.
 */
export async function countIpRequests(
  db: Database,
  ipHash: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(signInRequests)
    .where(
      and(
        eq(signInRequests.ipHash, ipHash),
        gte(signInRequests.requestedAt, ipWindowStart(now)),
      ),
    );
  return row?.n ?? 0;
}

/** Append one row to the ledger. The only thing that writes it. */
export async function recordSignInRequest(
  db: Database,
  entry: {
    shelterId: string | null;
    ipHash: string;
    mailSent: boolean;
  },
  now: Date,
): Promise<void> {
  await db.insert(signInRequests).values({
    id: crypto.randomUUID(),
    shelterId: entry.shelterId,
    ipHash: entry.ipHash,
    mailSent: entry.mailSent,
    requestedAt: now,
  });
}

/**
 * The facts `domain/`'s `isListed()` needs about one shelter.
 *
 * Three of the four clauses cannot be read from the schema yet, and each absence is a
 * different ticket rather than a gap here:
 *
 * - `latestVerificationOutcome` is **always `null`** because the verification log does not
 *   exist yet (issue #53). `null` is not a placeholder — ADR 0003 makes pending the absence
 *   of an entry, so a platform with no log at all is a platform where every shelter is
 *   pending, which is exactly true today. This is the clause that makes a newly registered
 *   shelter invisible, and it is doing real work.
 * - `departedAt` is always `null`; Departure lands with issue #65.
 *
 * When those tickets add their columns this function grows a join and every caller keeps
 * working, which is the reason the listing rule takes flat facts rather than rows.
 */
export async function readShelterFacts(
  db: Database,
  shelterId: string,
): Promise<ShelterFacts | null> {
  const [shelter] = await db
    .select({ id: shelters.id })
    .from(shelters)
    .where(eq(shelters.id, shelterId))
    .limit(1);
  if (!shelter) return null;

  const [contacts] = await db
    .select({ n: count() })
    .from(shelterContactPoints)
    .where(eq(shelterContactPoints.shelterId, shelterId));

  return {
    latestVerificationOutcome: null,
    contactPointCount: contacts?.n ?? 0,
    departedAt: null,
  };
}
