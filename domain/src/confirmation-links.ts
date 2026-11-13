/**
 * The link in a Confirmation Nudge: a Capability over one shelter's availability (ADR 0008).
 *
 * `digest/` builds it, `web/` serves the page it opens, so it lives in the package both
 * import — the argument `subscriber-links.ts` makes for the subscriber links.
 *
 * The MAC covers the shelter id, the nudge version and the current account email:
 *
 * - **Version.** Each nudge bumps `shelters.nudge_version`; a token whose version is not the
 *   current one is refused. That is supersession without a revoke list.
 * - **Account email.** ADR 0008 keys the link to the email on file. Signing it in means an
 *   email change invalidates every outstanding link with no extra state.
 *
 * Keyed by `SUBSCRIBER_LINK_SECRET` (provisioned as the platform's link-signing key) under a
 * label of its own, so no subscriber token can be read as a confirmation token.
 */

import { digestsEqual, sign } from "./keyed-hash.ts";
import { DAY_MS } from "./retention.ts";
import type { SubscriberLinkOrigin, SubscriberLinkSecrets } from "./subscriber-links.ts";

export const CONFIRM_PATH = "/refugios/confirmar";

export interface ConfirmationClaim {
  readonly shelterId: string;
  /** The `shelters.nudge_version` this nudge establishes. */
  readonly version: number;
  readonly accountEmail: string;
}

/** What the page has to read from the row to decide whether a token is still live. */
export interface ConfirmableShelter {
  readonly accountEmail: string;
  readonly nudgeVersion: number;
}

function mac(secrets: SubscriberLinkSecrets, claim: ConfirmationClaim): Promise<string> {
  return sign(
    secrets.SUBSCRIBER_LINK_SECRET,
    "confirm",
    `${claim.shelterId}:${claim.version}:${claim.accountEmail}`,
  );
}

/** `<origin>/refugios/confirmar/<shelterId>.<version>.<mac>` */
export async function confirmationUrl(
  config: SubscriberLinkSecrets & SubscriberLinkOrigin,
  claim: ConfirmationClaim,
): Promise<string> {
  const origin = config.SITE_ORIGIN.replace(/\/+$/, "");
  return `${origin}${CONFIRM_PATH}/${claim.shelterId}.${claim.version}.${await mac(config, claim)}`;
}

/**
 * The shelter this token may act for, or `null` when it is forged, malformed, superseded by
 * a newer nudge, or was issued to a previous account email. `load` reads the row; the
 * function stays pure.
 */
export async function verifyConfirmationToken(
  secrets: SubscriberLinkSecrets,
  token: string,
  load: (shelterId: string) => Promise<ConfirmableShelter | null>,
): Promise<string | null> {
  const macAt = token.lastIndexOf(".");
  const versionAt = macAt > 0 ? token.lastIndexOf(".", macAt - 1) : -1;
  if (versionAt <= 0) return null;

  const shelterId = token.slice(0, versionAt);
  const rawVersion = token.slice(versionAt + 1, macAt);
  if (!/^(?:0|[1-9]\d*)$/.test(rawVersion)) return null;
  const version = Number(rawVersion);

  const shelter = await load(shelterId);
  if (!shelter || shelter.nudgeVersion !== version) return null;

  const expected = await mac(secrets, { shelterId, version, accountEmail: shelter.accountEmail });
  return digestsEqual(token.slice(macAt + 1), expected) ? shelterId : null;
}

/**
 * Thirty days, used twice: an Available animal unconfirmed this long goes in the nudge, and
 * a shelter is nudged at most once in this long ("monthly", issue #60). It matches the end of
 * the `Fresh` staleness band, so a nudge arrives as an animal starts to show as ageing.
 */
export const CONFIRMATION_NUDGE_INTERVAL_MS = 30 * DAY_MS;
