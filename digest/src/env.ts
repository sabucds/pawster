import type { SubscriptionCriteria } from "@pawster/domain";

export interface DigestMessage {
  /** The day this run covers, `YYYY-MM-DD`. */
  period: string;
  subscriberId: string;
  email: string;
  /** Signs the footer's manage link, so a link from an older email dies with a rotation. */
  manageTokenVersion: number;
  /**
   * What this subscriber is being sent, one entry per saved search with something new, in
   * slot order. Chosen by the producer (`composeDigest`), so a redelivered message renders
   * and remembers exactly the same thing.
   */
  sections: DigestSection[];
}

export interface DigestSection {
  subscriptionId: string;
  /** The search, for the chips that head its section. */
  criteria: SubscriptionCriteria;
  /**
   * The rows shown. Each unit is its members' animal ids: one id for a single animal, two or
   * more for a bonded group. The consumer writes these and `repeats` into the sent-set after
   * the send succeeds, and nothing else, so what did not fit arrives next time.
   */
  units: string[][];
  /** Matched here but shown under an earlier section of the same email. */
  repeats: string[][];
  /** Matched but not shown: the "and N more" line. */
  more: number;
}

export interface Env {
  /** The same D1 database `web/` binds. */
  DB: D1Database;
  DIGEST_QUEUE: Queue<DigestMessage>;
  /**
   * The Healthchecks.io check URL. The watchdog must live outside Cloudflare or it shares
   * the failure it exists to detect (ADR 0006) — nothing inside Cloudflare can report a
   * cron run that never fired.
   */
  HEALTHCHECK_URL: string;
  RESEND_API_KEY: string;
  DIGEST_FROM_ADDRESS: string;
  /**
   * Where Pawster answers. Configuration rather than a literal because the apex is
   * registered outside Cloudflare and can move without a code change (ADR 0014).
   */
  SITE_ORIGIN: string;
  /**
   * Public base URL of the media bucket the thumbnails are served from. Not a secret; the
   * same value as `web/src/lib/listing/media.ts`.
   */
  MEDIA_BASE_URL: string;
  /**
   * Signs both subscriber links — the unsubscribe link in every digest's `List-Unsubscribe`
   * header, and the manage link the ninety-day nudge carries. A secret, never a `var` — see
   * `digest/wrangler.jsonc`.
   *
   * `web/` binds the same secret, because it verifies what this Worker signs. The
   * construction is shared rather than duplicated: `@pawster/domain`'s `subscriber-links.ts`.
   * It was named `UNSUBSCRIBE_SECRET` until issue #62 gave it a second kind of link to sign.
   */
  SUBSCRIBER_LINK_SECRET: string;
}
