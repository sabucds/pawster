export interface DigestMessage {
  /** The day this run covers, `YYYY-MM-DD`. */
  period: string;
  subscriberId: string;
  email: string;
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
