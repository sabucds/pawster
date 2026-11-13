/**
 * The monthly Confirmation Nudge (issue #60, ADR 0008): one email per shelter listing every
 * animal it has left unconfirmed for thirty days, with a link that can confirm them all or
 * mark any of them adopted without signing in.
 */

import { createDb, findShelterNudgesOwed, recordShelterNudge } from "@pawster/db";
import { CONFIRMATION_NUDGE_INTERVAL_MS, confirmationUrl } from "@pawster/domain";
import type { Env } from "./env.ts";

/**
 * Per cron run. `web/src/lib/subscriber/policy.ts` sets about four sends a day aside for
 * these out of Resend's free daily allowance; a backlog drains over the following days.
 */
export const CONFIRMATION_NUDGES_PER_RUN = 4;

/** Send the nudges owed today and return how many went out. Failures are left for tomorrow. */
export async function sendConfirmationNudges(env: Env, now: Date): Promise<number> {
  const db = createDb(env.DB);
  const cutoff = new Date(now.getTime() - CONFIRMATION_NUDGE_INTERVAL_MS);
  const owed = await findShelterNudgesOwed(
    db,
    { staleBefore: cutoff, nudgedBefore: cutoff },
    CONFIRMATION_NUDGES_PER_RUN,
  );

  let sent = 0;
  for (const nudge of owed) {
    const version = nudge.nudgeVersion + 1;
    try {
      const url = await confirmationUrl(env, {
        shelterId: nudge.shelterId,
        version,
        accountEmail: nudge.accountEmail,
      });
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.DIGEST_FROM_ADDRESS,
          to: [nudge.accountEmail],
          subject: "¿Siguen disponibles? Confirma tus animales en Pawster",
          text: [
            "Hace más de un mes que no confirmas que estos animales siguen disponibles:",
            "",
            ...nudge.animalNames.map((name) => `- ${name}`),
            "",
            "Desde este enlace puedes confirmarlos todos de una vez, o marcar los que ya fueron adoptados, sin iniciar sesión:",
            url,
            "",
            "Si reenvías este correo, quien lo reciba también podrá confirmar o cambiar el estado de estos animales. El enlace deja de funcionar cuando te enviemos el próximo.",
          ].join("\n"),
        }),
      });
      if (!response.ok) throw new Error(`Resend rejected the nudge: ${response.status}`);
      // Only after the send succeeded: recording first would retire the link the shelter holds
      // for one it never received.
      await recordShelterNudge(db, { shelterId: nudge.shelterId, sentVersion: version }, now);
      sent++;
    } catch {
      // Left unrecorded on purpose, so the next run tries this shelter again.
    }
  }
  return sent;
}
