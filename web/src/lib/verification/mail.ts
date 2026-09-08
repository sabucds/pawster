/**
 * The three emails verification sends, and the two audiences they are written for.
 *
 * `POST /emails` per message, the same endpoint and posture `digest/src/resend.ts` and
 * `../auth/mail.ts` use, and never the batch endpoint — for the reason both of those record:
 * its idempotency key covers the whole payload, which is wrong for a per-recipient send.
 *
 * **No idempotency key, like the sign-in code and unlike the digest.** A digest is
 * re-runnable by construction. None of these is a retry of anything: a second registration
 * is a second shelter, a second decision is a second entry in an append-only log, and a
 * second drift of a cited artifact is a second thing the admin has to look at. A key derived
 * from the shelter and the day would silently swallow the second one.
 *
 * ## Two audiences, two languages, and the boundary is here
 *
 * The two mails to the admin are English: the Platform Admin is "a role in the domain, not
 * in the auth system" (`CONTEXT.md`) and in practice the maintainer who reads this
 * repository, so `CONTEXT.md`'s *User-facing Spanish* table — which governs what adopters
 * and shelters read — does not reach them. The mail to the *shelter* is es-VE and uses that
 * table's vocabulary, because a shelter is a user.
 *
 * ## Why a sender of its own
 *
 * `VERIFICATION_FROM_ADDRESS` rather than reusing `SIGN_IN_FROM_ADDRESS`. `web/src/env.d.ts`
 * already makes this argument for holding sign-in apart from the digest — "so that a
 * shelter's mail client and Postmaster Tools can tell a credential from a newsletter, and so
 * that a spam complaint about the digest cannot take the sign-in sender's reputation with
 * it" — and a refusal is the message on this platform most likely to be marked as spam by
 * the person receiving it. Letting that land on the address that carries login codes would
 * put sign-in's deliverability at the mercy of the platform's least welcome mail.
 */

import type { VerificationOutcome } from "@pawster/domain";
import type { StoredContactPoint } from "../shelter/store.ts";
import { CONTACT_POINT_LABELS } from "../shelter/fields.ts";
import { DECISION_LINK_TTL_MS, PENDING_LIST_LINK_TTL_MS } from "./policy.ts";

export interface VerificationMailEnv {
  readonly RESEND_API_KEY: string;
  readonly VERIFICATION_FROM_ADDRESS: string;
  /**
   * The one address a signed link is ever sent to, and therefore the whole of who the admin
   * is (ADR 0002). A `var` rather than a secret: it is not a credential, it is a
   * destination — and it is already in `.env.example` as `PAWSTER_ADMIN_EMAIL`.
   */
  readonly ADMIN_EMAIL: string;
  readonly SITE_ORIGIN: string;
}

const DECISION_LINK_DAYS = Math.round(DECISION_LINK_TTL_MS / (24 * 60 * 60_000));
const PENDING_LINK_HOURS = Math.round(PENDING_LIST_LINK_TTL_MS / (60 * 60_000));

/** The shelter facts a decision mail describes. No account email — see below. */
export interface MailedShelter {
  readonly displayName: string;
  readonly slug: string;
  readonly baseRegion: string;
  readonly countryCode: string;
  readonly contactPoints: readonly StoredContactPoint[];
}

async function send(
  env: VerificationMailEnv,
  message: {
    to: string;
    subject: string;
    text: string;
    /** Set on shelter-facing mail, where a reply has to reach a person. */
    replyTo?: string;
  },
): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.VERIFICATION_FROM_ADDRESS,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend rejected a verification email: ${response.status}`);
  }
}

function describeContactPoints(points: readonly StoredContactPoint[]): string {
  if (points.length === 0) {
    return "  (none — nothing this shelter publishes can be listed until it adds one)";
  }
  return points
    .map(
      (point, index) =>
        `  ${index + 1}. ${CONTACT_POINT_LABELS[point.kind]}: ${point.value}` +
        (index === 0 ? "   ← the one adopters are offered first" : ""),
    )
    .join("\n");
}

/**
 * The mail a registration sends the admin: one decision link, and the pending list beside
 * it.
 *
 * **The link opens a page; it decides nothing.** ADR 0008 forbids an emailed link from
 * mutating on `GET` and says the rule "applies equally to ADR 0002's verification-decision
 * links, where a scanner silently verifying a shelter would be worse" — so the mail says
 * that in as many words, because the admin is the one person who would otherwise wonder why
 * there is no one-tap verify.
 *
 * **The shelter's account email is not in this mail and not on the page it links to.** The
 * judgement is about a public presence, so the address adds nothing to it; and the address is
 * the shelter's whole credential, which does not belong in a message whose whole security
 * model is that a bearer link stays in one inbox.
 *
 * The pending-list link rides along because it is the only way the admin gets one without a
 * terminal, and it is honest about dying first: 24 hours against the decision link's seven
 * days, because the pending list enumerates every waiting shelter and is the higher-value
 * target of the two (ADR 0002).
 */
export async function sendDecisionRequestEmail(
  env: VerificationMailEnv,
  mail: {
    readonly shelter: MailedShelter;
    readonly decisionUrl: string;
    readonly pendingUrl: string;
  },
): Promise<void> {
  const { shelter } = mail;
  await send(env, {
    to: env.ADMIN_EMAIL,
    subject: `Pawster: verify ${shelter.displayName}?`,
    text: [
      `${shelter.displayName} registered and is waiting on a verification decision.`,
      "",
      `  Where:   ${shelter.baseRegion}, ${shelter.countryCode}`,
      `  Public:  ${env.SITE_ORIGIN}/refugios/${shelter.slug}`,
      "  Contact points:",
      describeContactPoints(shelter.contactPoints),
      "",
      "Nothing this shelter publishes is visible to anyone until an entry says Verified.",
      "It can publish now, and everything it publishes appears the moment you decide.",
      "",
      `Decide here (opens a page, decides nothing until you press a button; ${DECISION_LINK_DAYS} days):`,
      `  ${mail.decisionUrl}`,
      "",
      `Everything else waiting (${PENDING_LINK_HOURS} hours, because it lists every shelter):`,
      `  ${mail.pendingUrl}`,
      "",
      "The shelter was told it would hear back within three days, and invited to chase.",
    ].join("\n"),
  });
}

/**
 * What a shelter is told about a refusal or a revocation, in es-VE, **inviting a reply**.
 *
 * The reply is the point rather than a courtesy. Issue #45's user story: "I want a refusal or
 * a Revocation to arrive as a real email inviting a reply, so that a mistake about me is
 * correctable by a human" — and ADR 0002 left exactly one human doing the verifying, so
 * `reply_to` is that person's own address and not a no-reply mailbox.
 *
 * **The evidence text is not in here.** It is written for the log and for whoever reads it
 * years later (ADR 0003), addressed to a future maintainer rather than to the shelter, and
 * `policy.ts`'s evidence rule tells the admin to write about artifacts rather than to a
 * shelter. What the shelter needs is the decision, what it means, and a person to answer —
 * and the reply is where the specifics belong, because a refusal is a conversation and not a
 * notification.
 *
 * A `Verified` outcome sends nothing, which is deliberate and worth naming: the shelter's own
 * panel already says whether anything of its is visible, computed from `isListed()` rather
 * than from a stored flag, so a "you are verified" mail would be a second announcement that
 * can disagree with the page. Shelter-facing mail cadence belongs to the nudge ticket (#60).
 */
export async function sendOutcomeEmail(
  env: VerificationMailEnv,
  mail: {
    readonly to: string;
    readonly displayName: string;
    readonly outcome: Exclude<VerificationOutcome, "Verified">;
  },
): Promise<void> {
  const refused = mail.outcome === "Refused";

  await send(env, {
    to: mail.to,
    replyTo: env.ADMIN_EMAIL,
    subject: refused
      ? "Sobre el registro de tu refugio en Pawster"
      : "Tus animales dejaron de aparecer en Pawster",
    text: [
      `Hola, ${mail.displayName}.`,
      "",
      refused
        ? "Revisamos el registro de tu refugio y por ahora no lo pudimos verificar, así " +
          "que lo que publiques todavía no le aparece a los adoptantes."
        : "Retiramos la verificación de tu refugio, así que tus animales dejaron de " +
          "aparecerle a los adoptantes. No se borró nada: todo lo que publicaste sigue ahí.",
      "",
      // Plain text, so the emphasis is the sentence order and not any markup: the reply is
      // the first thing asked for, because it is the only thing the shelter can do.
      "Esto no es definitivo y puede ser un error nuestro. Respóndele a este correo y lo " +
        "revisa una persona: mándanos el Instagram, la página o cualquier cosa pública del " +
        "refugio que nos ayude a confirmar quiénes son.",
      "",
      `Puedes seguir entrando en ${env.SITE_ORIGIN}/refugios/entrar y no se pierde nada de ` +
        "lo que tengas publicado.",
    ].join("\n"),
  });
}

/**
 * The dead-man's switch (ADR 0019): a verified shelter has edited something the entry that
 * verified it was written against.
 *
 * "A check with a dead-man's switch and not a cron" — issue #53. ADR 0003 rules out an
 * expiry job for verification, and ADR 0002 rules out a cron over the queue, both on issue
 * #6's finding that a scheduled writer which never fires is undetectable. What is left is
 * this: nothing re-checks a shelter on a timer, and the one event that could invalidate a
 * check tells the admin the moment it happens.
 *
 * It carries a fresh decision link, because the admin's next move is to look at the shelter
 * as it is now and either write a new entry or leave the old one standing.
 */
export async function sendCitedArtifactsChangedEmail(
  env: VerificationMailEnv,
  mail: {
    readonly shelter: MailedShelter;
    readonly citedDisplayName: string;
    readonly citedContactPoints: readonly StoredContactPoint[];
    readonly decisionUrl: string;
  },
): Promise<void> {
  const nameChanged = mail.citedDisplayName !== mail.shelter.displayName;

  await send(env, {
    to: env.ADMIN_EMAIL,
    subject: `Pawster: ${mail.citedDisplayName} changed what you verified`,
    text: [
      `${mail.citedDisplayName} is verified, and has just edited the details that`,
      "verification was written against. Its animals are still listed.",
      "",
      nameChanged
        ? `  Display name:  ${mail.citedDisplayName}  ->  ${mail.shelter.displayName}`
        : `  Display name:  ${mail.shelter.displayName}  (unchanged)`,
      "",
      "  Contact points, as verified:",
      describeContactPoints(mail.citedContactPoints),
      "",
      "  Contact points, now:",
      describeContactPoints(mail.shelter.contactPoints),
      "",
      "This is one email per drift, not one per edit: if it edits these again you will not",
      "hear about it until a new entry cites the new values.",
      "",
      "Look at it as it stands now, and decide again or leave the entry alone:",
      `  ${mail.decisionUrl}`,
    ].join("\n"),
  });
}
