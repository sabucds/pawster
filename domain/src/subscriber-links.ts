/**
 * The two signed links a subscriber is ever given, and the only credentials they hold.
 *
 * `CONTEXT.md`: a Subscription is "managed entirely through signed links; never behind a
 * login", and a Subscriber "has no account and no password". So a link **is** the credential,
 * and an unsigned `/resumen/mis-busquedas/<subscriberId>` would hand anyone who can guess an
 * id somebody else's address, searches and delete button. The id is the only thing either
 * Worker knows about a recipient, which makes guessability the whole risk.
 *
 * ## Why both are built here rather than in the Worker that sends them
 *
 * Each link is built in one Worker and verified in the other. `digest/` puts the unsubscribe
 * link in the `List-Unsubscribe` header of every digest and the manage link in the ninety-day
 * nudge; `web/` serves both of the pages they open. Neither may import the other, so the
 * construction lives in the package both depend on — the same argument
 * `domain/src/retention.ts` makes for the periods, one level down.
 *
 * ## The two differ in exactly one way, and that difference is the ticket
 *
 * An **unsubscribe** token is a MAC over the subscriber id alone, so it never changes and
 * never expires. That is required rather than convenient: the header is already in every
 * digest ever delivered, and RFC 8058 one-click must keep working from a message a subscriber
 * kept for a year. Unsubscribing twice is unsubscribing once.
 *
 * A **manage** token is a MAC over the id *and a version*, and
 * [ADR 0010](../../docs/adr/0010-subscriber-data-retention.md) requires it to be rotated when
 * a subscriber unsubscribes. Bumping the version is the rotation: every link previously
 * handed out stops verifying, and no shared state has to be revoked. The row stores nothing
 * but a small integer — no token, no hash of one — so a database read is not a set of working
 * links, and the nudge can still build the *current* link months later without one having
 * been kept anywhere.
 *
 * That asymmetry is what makes ADR 0010's closing move work: "the manage token is rotated on
 * unsubscribe, so an unsubscribed subscriber's route is the 'delete everything' button on the
 * unsubscribe landing page itself... no fresh token is issued there, which would undo what
 * the rotation defends against." The unsubscribe link survives the rotation *because* it is
 * versionless, and that is precisely why it is the one that carries erasure.
 */

import { digestsEqual, sign } from "./keyed-hash.ts";

/**
 * The secret both links are keyed by, and the one piece of configuration both Workers must
 * agree on.
 *
 * One secret rather than two, because ADR 0013's rule is that "every additional secret is
 * another thing `wrangler secret put` has to be told about and another way a deploy can be
 * half-configured", and these two links fail in the same direction: lose it and every
 * outstanding subscriber link stops verifying, which strands subscribers on a published
 * contact address but mails nobody who should not be mailed. That is the **closed** failure
 * `web/src/lib/subscriber/crypto.ts` contrasts with the pepper's open one, so it does not
 * earn the pepper's separation.
 *
 * Domain separation between the two link kinds is the labels table's job, not a second key's
 * — see `keyed-hash.ts`.
 */
export interface SubscriberLinkSecrets {
  readonly SUBSCRIBER_LINK_SECRET: string;
}

/**
 * Where Pawster answers. Configuration rather than a literal, because the apex is registered
 * outside Cloudflare and can move without a code change (ADR 0014).
 */
export interface SubscriberLinkOrigin {
  readonly SITE_ORIGIN: string;
}

/** The subscriber-facing route prefixes, written once so a link and its page cannot disagree. */
export const UNSUBSCRIBE_PATH = "/resumen/baja";
export const MANAGE_PATH = "/resumen/mis-busquedas";

function origin(config: SubscriberLinkOrigin): string {
  return config.SITE_ORIGIN.replace(/\/+$/, "");
}

/**
 * `<subscriberId>.<mac>` — the whole of a one-click unsubscribe credential.
 *
 * The id travels in the clear beside its MAC rather than being looked up from an opaque
 * handle, so the route can find the row without a second table and a spent link is still a
 * valid link. Nothing here expires, for the reason in the module comment.
 */
export async function unsubscribeToken(
  secrets: SubscriberLinkSecrets,
  subscriberId: string,
): Promise<string> {
  const mac = await sign(
    secrets.SUBSCRIBER_LINK_SECRET,
    "unsubscribe",
    subscriberId,
  );
  return `${subscriberId}.${mac}`;
}

/**
 * The subscriber this unsubscribe token names, or `null` if it was not signed by us.
 *
 * `lastIndexOf` rather than `split`, because a subscriber id is a UUID today and the format
 * is not this function's business: everything before the final separator is the id.
 */
export async function verifyUnsubscribeToken(
  secrets: SubscriberLinkSecrets,
  token: string,
): Promise<string | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const subscriberId = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  const expected = await sign(
    secrets.SUBSCRIBER_LINK_SECRET,
    "unsubscribe",
    subscriberId,
  );
  return digestsEqual(presented, expected) ? subscriberId : null;
}

/** What a manage token carries: who, and which generation of their link this is. */
export interface ManageClaim {
  readonly subscriberId: string;
  /** `subscribers.manage_token_version` as it stood when the link was built. */
  readonly version: number;
}

/**
 * `<subscriberId>.<version>.<mac>` — a manage credential for one generation of one
 * subscriber's link.
 *
 * The version is *inside* the MAC as well as beside it, which is the only thing that makes
 * rotation real: a holder who edits the visible version to an older or newer one produces a
 * token whose MAC no longer verifies.
 */
export async function manageToken(
  secrets: SubscriberLinkSecrets,
  claim: ManageClaim,
): Promise<string> {
  const mac = await sign(
    secrets.SUBSCRIBER_LINK_SECRET,
    "manage",
    `${claim.subscriberId}:${claim.version}`,
  );
  return `${claim.subscriberId}.${claim.version}.${mac}`;
}

/**
 * What this manage token claims, or `null` if it was not signed by us or is malformed.
 *
 * **This says nothing about whether the token is still current.** Verification proves the
 * platform built the token; only the row knows which version is live, so the caller compares
 * `claim.version` against `subscribers.manage_token_version` and refuses a stale one. Keeping
 * the two apart is what lets this stay pure and testable without a database, and it is why
 * the version is returned rather than merely checked.
 */
export async function verifyManageToken(
  secrets: SubscriberLinkSecrets,
  token: string,
): Promise<ManageClaim | null> {
  const mac = token.lastIndexOf(".");
  if (mac <= 0) return null;
  const versionAt = token.lastIndexOf(".", mac - 1);
  if (versionAt <= 0) return null;

  const subscriberId = token.slice(0, versionAt);
  const rawVersion = token.slice(versionAt + 1, mac);
  const presented = token.slice(mac + 1);

  /**
   * A canonical decimal integer and nothing else. `Number("0x1")` and `Number(" 1 ")` both
   * parse, and either would let two spellings of one version exist — only one of which the
   * MAC was taken over, so the check below would reject them anyway. Refusing here keeps the
   * rejection a parse failure rather than a signature failure, which is the truthful one.
   */
  if (!/^(?:0|[1-9]\d*)$/.test(rawVersion)) return null;
  const version = Number(rawVersion);

  const expected = await sign(
    secrets.SUBSCRIBER_LINK_SECRET,
    "manage",
    `${subscriberId}:${version}`,
  );
  return digestsEqual(presented, expected) ? { subscriberId, version } : null;
}

/** `<origin>/resumen/baja/<token>` — the URL in every digest's `List-Unsubscribe` header. */
export async function unsubscribeUrl(
  config: SubscriberLinkSecrets & SubscriberLinkOrigin,
  subscriberId: string,
): Promise<string> {
  return `${origin(config)}${UNSUBSCRIBE_PATH}/${await unsubscribeToken(config, subscriberId)}`;
}

/**
 * `<origin>/resumen/mis-busquedas/<token>` — the subject-access response, and the page the
 * erasure button sits on.
 */
export async function manageUrl(
  config: SubscriberLinkSecrets & SubscriberLinkOrigin,
  claim: ManageClaim,
): Promise<string> {
  return `${origin(config)}${MANAGE_PATH}/${await manageToken(config, claim)}`;
}
