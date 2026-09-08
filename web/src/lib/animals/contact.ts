/**
 * The hand-off: how one of a shelter's contact points becomes a link that leaves Pawster, and
 * what the adopter's message already says when it opens.
 *
 * The public-listing prototype's finding, kept verbatim because it is the reason this file is
 * not a template in the page: *"The CTA is not just a link; it is the only join between the
 * platform and the conversation."* Contact is off-platform by design — the platform holds no
 * messages and no accounts for adopters — so the only thing that can tell a shelter which
 * animal a stranger's WhatsApp is about is what the link put in the message box before they
 * typed. Get that wrong and a shelter reads `Hola, ¿sigue disponible?` with no idea which of
 * its forty animals is meant.
 *
 * ## Ordered, not equal
 *
 * A shelter holds an **ordered** set of contact points and the order is its own decision
 * (`CONTEXT.md`, *Contact Point*): position 0 is the channel it actually answers. So the page
 * offers the first as a filled button and the rest as a compact row, and this module preserves
 * that order rather than sorting or grouping by kind. The prototype measured the alternative:
 * four equal buttons hand an adopter a decision they have no basis for making, and a shelter
 * with four points renders as a 2×2 grid of identical choices.
 *
 * ## Pure, and separate from the page
 *
 * `FormData` never reaches here and neither does a database. Contact values are stored exactly
 * as the shelter typed them (`../shelter/fields.ts` validates length and kind and nothing
 * else), so every normalisation a `wa.me` or a `tel:` needs happens at render time, here, where
 * it is a table test. Doing it at write time would rewrite what a shelter typed into its own
 * profile form.
 */

import type { ContactPointKind } from "@pawster/db";
import type { StoredContactPoint } from "../shelter/store.ts";

/**
 * What each channel's button says, in es-VE.
 *
 * The verb rather than the channel — `Escribir por WhatsApp`, not `WhatsApp` — because the
 * filled button is an instruction and the adopter is about to do the thing it names. `Llamar`
 * is the one that is not writing, and it is worth the row: a phone number offered as
 * "escribir" is a promise the channel cannot keep.
 *
 * Held apart from `../shelter/fields.ts`'s `CONTACT_POINT_LABELS`, which labels the *form* a
 * shelter fills in. That table names the channel (`Correo`); this one names the act. Merging
 * them would give the shelter's form a button verb and this page a bare noun.
 */
export const CONTACT_ACTION_LABELS: Record<ContactPointKind, string> = {
  whatsapp: "Escribir por WhatsApp",
  instagram: "Escribir por Instagram",
  email: "Escribir un correo",
  phone: "Llamar",
};

/** The compact row's labels: the channel alone, because the row is a list of alternatives. */
export const CONTACT_SHORT_LABELS: Record<ContactPointKind, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  email: "Correo",
  phone: "Teléfono",
};

/** Shown above the quoted prefill, so an adopter is not surprised by what they are sending. */
export const PREFILL_NOTE = "El mensaje sale escrito así:";

/**
 * Said once, under the contact block.
 *
 * Not a disclaimer bolted on for form. The platform genuinely keeps nothing of the
 * conversation, which is both a privacy fact worth stating and the reason the prefill has to
 * carry the animal's address — there is no thread on Pawster for the shelter to look the
 * animal up in afterwards.
 */
export const OFF_PLATFORM_NOTE =
  "La conversación sigue fuera de Pawster. No guardamos nada de lo que hablen.";

/**
 * The message the shelter receives, naming the animal and its short id.
 *
 * The address is in it because the name is not an identifier: a shelter with two Lunas, or one
 * that renamed this animal last week, cannot resolve a message that carries only a name. The
 * short id can be pasted back into a URL bar, which is what makes it worth the characters — see
 * `short-id.ts` for why the id is eight symbols rather than a UUID, and note that this line is
 * the whole argument.
 *
 * `address` is passed in — `./address.ts`'s `messageAddress()` builds it — rather than
 * assembled here from `SITE_ORIGIN`, because reading an environment variable is exactly the
 * impurity this module does not have, and because an address written in two places is two
 * addresses. That module owns the address; this one owns the sentence.
 *
 * The question at the end is deliberate and it is the adopter's, not ours: the one thing an
 * adopter most needs to know is the one thing an archive page could not have told them, because
 * the animal is still listed.
 */
export function prefillMessage(animalName: string, address: string): string {
  return `Hola, les escribo por ${animalName} (${address}). ¿Sigue disponible?`;
}

/** One contact point, ready to render. */
export interface ContactHandoff {
  readonly kind: ContactPointKind;
  /**
   * Where the button goes, or `null` when this value cannot become one.
   *
   * Nullable because the values are shelter-typed and unvalidated beyond their length: a
   * WhatsApp point holding `pregúntanos` has no number in it. The page renders those as plain
   * text rather than as a link, which is worse than a working button and much better than a
   * button that goes nowhere — an adopter who taps a dead link concludes the animal is gone.
   */
  readonly href: string | null;
  /** What the filled button says. */
  readonly label: string;
  /** What the compact row says. */
  readonly shortLabel: string;
  /** As the shelter typed it, shown on the channels where the link cannot show it. */
  readonly value: string;
  /** Whether the prefilled message actually travels on this channel. */
  readonly carriesPrefill: boolean;
}

/**
 * A WhatsApp number as `wa.me` wants it: digits only, no `+`, no spaces.
 *
 * A leading `00` is dropped, because it is the international access prefix and `wa.me` wants
 * the country code bare — a shelter that typed `0058 412…` means the same number as one that
 * typed `+58 412…`.
 *
 * **A locally-formatted number is left as it was typed and will not work**, and that is a
 * deliberate refusal rather than a gap. A Venezuelan shelter typing `0412 5550001` means
 * `+58 412 5550001`, and converting it requires knowing that `0` is Venezuela's trunk prefix —
 * a per-country rule the platform would then own for every country it claims to work in
 * (`CONTEXT.md`: "Built for Venezuelan shelters first, modelled to work anywhere"). Guessing
 * one country's rule and applying it to all of them silently mangles every other country's
 * numbers, which is worse than a link that visibly does not work. The place to fix this is the
 * profile form, where a shelter can be asked for the international form and can see what it
 * typed.
 */
function whatsappDigits(value: string): string | null {
  const digits = value.replace(/\D/g, "").replace(/^00/, "");
  return digits.length === 0 ? null : digits;
}

/**
 * An Instagram value as a profile URL, from any of the three ways a shelter writes it:
 * `@refugio`, `refugio`, or a pasted `https://instagram.com/refugio`.
 *
 * A pasted URL is returned unchanged rather than parsed down to a handle and rebuilt — the
 * shelter pasted something that works, and rebuilding it would drop whatever it carried that
 * this function does not know about.
 */
function instagramUrl(value: string): string | null {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const handle = trimmed
    .replace(/^@/, "")
    .replace(/^(?:www\.)?instagram\.com\//i, "")
    .replace(/\/+$/, "");
  return handle.length === 0 ? null : `https://instagram.com/${handle}`;
}

/** `tel:` keeps the `+`, which is the one character that makes a number dialable abroad. */
function telUri(value: string): string | null {
  const dialable = value.replace(/[^\d+]/g, "");
  return /\d/.test(dialable) ? `tel:${dialable}` : null;
}

/**
 * `mailto:` with the message already in the body.
 *
 * The subject names the animal too, because a subject line is what a shelter sees in a list of
 * forty unread messages and `(sin asunto)` is what it would otherwise see.
 */
function mailtoUri(value: string, animalName: string, prefill: string): string | null {
  const address = value.trim();
  if (!address.includes("@")) return null;
  const query = new URLSearchParams({
    subject: `Adopción de ${animalName}`,
    body: prefill,
  });
  // `URLSearchParams` encodes a space as `+`, which is right in a query string and wrong in a
  // `mailto:` body — several clients render the plus literally. `%20` is correct in both.
  return `mailto:${address}?${query.toString().replace(/\+/g, "%20")}`;
}

/**
 * Every contact point as a hand-off, in the shelter's own order.
 *
 * The first element is the one the page renders as a filled button. That is not stated in the
 * return type — a `{ primary, rest }` shape was the alternative and it lies about a shelter
 * with one contact point, which has a primary and no rest and would render an empty row.
 *
 * Only two channels carry the prefill, and the asymmetry is the platforms', not ours: `wa.me`
 * takes a `?text=` and `mailto:` takes a `?body=`, while Instagram's web profile has no message
 * parameter at all and a phone call has no text. {@link ContactHandoff.carriesPrefill} is
 * returned rather than left for the page to infer from the kind, so the page can show the
 * quoted message under a block where at least one channel will actually send it.
 */
export function contactHandoffs(
  points: readonly StoredContactPoint[],
  animalName: string,
  prefill: string,
): readonly ContactHandoff[] {
  return points.map((point) => ({
    kind: point.kind,
    href: hrefFor(point, animalName, prefill),
    label: CONTACT_ACTION_LABELS[point.kind],
    shortLabel: CONTACT_SHORT_LABELS[point.kind],
    value: point.value,
    carriesPrefill: point.kind === "whatsapp" || point.kind === "email",
  }));
}

function hrefFor(
  point: StoredContactPoint,
  animalName: string,
  prefill: string,
): string | null {
  switch (point.kind) {
    case "whatsapp": {
      const digits = whatsappDigits(point.value);
      // `encodeURIComponent` rather than `URLSearchParams`, for the `+`-as-space reason above:
      // a prefill reading `hace 4 meses` must not arrive as `hace+4+meses`.
      return digits === null
        ? null
        : `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
    }
    case "instagram":
      return instagramUrl(point.value);
    case "email":
      return mailtoUri(point.value, animalName, prefill);
    case "phone":
      return telUri(point.value);
  }
}
