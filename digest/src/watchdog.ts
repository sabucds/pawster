/**
 * The dead man's switch. Nothing inside Cloudflare can report a cron run that never fired
 * — there is no Workers or Cron entry in Cloudflare's notification catalogue and no
 * documented retry policy for `scheduled` invocations — so the watchdog lives outside
 * Cloudflare or it shares the failure it exists to detect (ADR 0006).
 */

/**
 * ADR 0009 asks for exactly two pings: one per daily run at completion, and `/fail` from
 * the dead-letter consumer. There is deliberately no `start` — Healthchecks.io's grace
 * period is what covers a run that never finishes, so a start ping would add a second
 * outbound call per run and tell us nothing the grace period does not.
 */
export type PingKind = "success" | "fail";

/**
 * Healthchecks.io addresses its endpoints by suffix on the check URL, and the bare URL is
 * the success ping.
 */
function endpointFor(baseUrl: string, kind: PingKind): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return kind === "success" ? trimmed : `${trimmed}/${kind}`;
}

/**
 * Never throws. A watchdog that can fail the run it is watching turns a monitoring
 * outage into a delivery outage, which is exactly backwards.
 */
export async function pingWatchdog(
  baseUrl: string,
  kind: PingKind,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await fetch(endpointFor(baseUrl, kind), {
      method: "POST",
      body: JSON.stringify(detail),
    });
  } catch (error) {
    console.error("watchdog ping failed", kind, error);
  }
}
