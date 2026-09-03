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
}
