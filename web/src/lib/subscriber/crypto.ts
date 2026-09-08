/**
 * The four keyed hashes the subscriber path is built from, and the one random token it
 * hands out.
 *
 * All of them go through [`../auth/crypto.ts`](../auth/crypto.ts)'s `sign()`, so the labels
 * live in that one table and the primitive is imported rather than re-chosen. What is here
 * is which key each hash is taken under, and the argument for there being two of them.
 *
 * ## Why the pepper is a secret of its own
 *
 * ADR 0013's rule is that few secrets is better than many — "every additional secret is
 * another thing `wrangler secret put` has to be told about and another way a deploy can be
 * half-configured" — and `SUBSCRIBER_SECRET` follows it, keying three of the four hashes
 * below. `DO_NOT_CONTACT_PEPPER` is the fourth and does not, because the two keys **fail in
 * opposite directions**, and that is a sharper distinction than the blast-radius argument
 * `ORIGINAL_SECRET` was granted on.
 *
 * Rotate or lose `SUBSCRIBER_SECRET` and every outstanding opt-in link stops verifying, every
 * IP bucket empties and every cooldown resets. All three fail **closed**: nobody is mailed
 * who should not be, the damage is bounded by the seven-day link lifetime and the
 * one-hour IP window, and a subscriber whose link died asks for another.
 *
 * Rotate or lose the pepper and, in
 * [ADR 0010](../../../../docs/adr/0010-subscriber-data-retention.md)'s own words, "every
 * Do-Not-Contact entry silently stops matching and the platform resumes mailing people who
 * reported it as spam, with no alarm anywhere". That fails **open**, against the one
 * obligation in the whole design that has no sunset (15 U.S.C. §7704(a)(4)(A)(i)). Sharing a
 * key would mean a routine rotation of the first kind quietly performing the second, so the
 * two are separate and the pepper carries the canary below.
 */

import { sign, toBase64Url } from "../auth/crypto.ts";

export interface SubscriberSecrets {
  /** Keys the opt-in token hash, the signup IP fingerprint and the mail ledger's address fingerprint. */
  readonly SUBSCRIBER_SECRET: string;
  /** Keys Do-Not-Contact entries, and nothing else. Never rotated — see the module comment. */
  readonly DO_NOT_CONTACT_PEPPER: string;
}

/**
 * A fresh opt-in token: 32 random bytes as base64url.
 *
 * Unguessable rather than merely unique, because possession of one is proof of a mailbox and
 * redemption writes a subscriber. 32 bytes puts brute-forcing it out of reach, which matters
 * more here than for a One-Time Code: there is no five-attempt ceiling on this one and no
 * cheap way to add one, since a guess costs an attacker a single `GET`.
 *
 * The same construction as `generateRequestToken()` and deliberately not the same function.
 * That one is a *handle* — it names an outstanding code and grants nothing on its own — and
 * this is a *capability*. Two names for one shape is worth it where one of them would
 * otherwise read as reusable for the other.
 */
export function generateOptInToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The stored form of an opt-in token.
 *
 * The token is not scoped to an address inside the message, unlike `hashOneTimeCode()`, and
 * the difference is what the row is keyed by: an opt-in row is *found* by this hash, so
 * there is nothing to scope it to at lookup time. A hash lifted from one row cannot be
 * replayed against another anyway — it is the primary key, so it only ever names its own row.
 */
export function hashOptInToken(
  secrets: SubscriberSecrets,
  token: string,
): Promise<string> {
  return sign(secrets.SUBSCRIBER_SECRET, "optIn", token);
}

/**
 * The stored form of a signup caller's IP. A fingerprint and not the address, the same
 * posture the sign-in ledger takes: the column answers "how many signups from this caller in
 * the last hour" and needs nothing else.
 *
 * Keyed separately from `hashIp()`'s `ip:` label so that the two ledgers cannot be joined on
 * a caller. A shelter signing in and an adopter signing up are two people the platform has
 * no reason to be able to identify as one, and reusing the label would have made that a
 * `SELECT` anybody with query access could write.
 */
export function hashSignupIp(
  secrets: SubscriberSecrets,
  ip: string,
): Promise<string> {
  return sign(secrets.SUBSCRIBER_SECRET, "signupIp", ip);
}

/**
 * The stored form of a subscriber's address in the opt-in mail ledger.
 *
 * Deterministic, because the cooldown asks "when did we last mail *this* address" and needs
 * to find the rows. Keyed, because the alternative — a bare SHA-256 — is enumerable over the
 * address space, which is exactly the reasoning ADR 0010 gives for Do-Not-Contact being an
 * HMAC. Under `SUBSCRIBER_SECRET` rather than the pepper: losing this one loses a day's
 * cooldowns, which is the closed-failure side of the module comment's split.
 */
export function hashSubscriberEmail(
  secrets: SubscriberSecrets,
  email: string,
): Promise<string> {
  return sign(secrets.SUBSCRIBER_SECRET, "subscriber", normaliseAddress(email));
}

/**
 * The stored form of a Do-Not-Contact entry: `HMAC-SHA256(pepper, "dnc:" || address)`.
 *
 * ADR 0010: matching requires deterministic digests, which rules out per-record salting, and
 * a shared salt "leaves you exposed to brute force" over an address space small enough to
 * enumerate. A keyed MAC with the key held outside the database is the ICO's own remedy, and
 * it also sidesteps that guidance's preference for slow hashes — slowness only buys anything
 * when the attacker knows the salt, and an attacker holding this table without the pepper
 * cannot compute a single candidate.
 */
export function doNotContactDigest(
  secrets: SubscriberSecrets,
  email: string,
): Promise<string> {
  return sign(
    secrets.DO_NOT_CONTACT_PEPPER,
    "doNotContact",
    normaliseAddress(email),
  );
}

/**
 * The address as every digest above sees it: trimmed and lower-cased.
 *
 * **The same normalisation on both sides is the whole of matching**, so it is one function
 * rather than a `.toLowerCase()` at each call site. A Do-Not-Contact entry written over
 * `Ana@Correo.example` and a signup typed as `ana@correo.example` are the same person, and
 * a mismatch here does not fail loudly — it resumes mailing someone who reported us as spam,
 * which is the failure the pepper's canary exists to catch in its other form.
 *
 * Nothing beyond case is touched. Stripping dots or `+tags` from the local part is a
 * Gmail-specific convention that is wrong at other providers, and getting it wrong in that
 * direction merges two people's addresses into one refusal.
 */
export function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The fixed subject of the pepper canary.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so this is a string no
 * subscriber can type into the signup form and no mail can be sent to. That is what lets the
 * canary share `do_not_contact` with real entries: it can never be reached by the refusal
 * path it sits next to.
 */
export const DO_NOT_CONTACT_CANARY_SUBJECT = "canary@pawster.invalid";

/** The canary's digest under the pepper currently configured. */
export function doNotContactCanary(
  secrets: SubscriberSecrets,
): Promise<string> {
  return doNotContactDigest(secrets, DO_NOT_CONTACT_CANARY_SUBJECT);
}
