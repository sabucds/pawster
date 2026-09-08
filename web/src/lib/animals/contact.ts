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
 * Everything that differs between the four channels, in one record per channel.
 *
 * **One table and not four.** The first draft had a labels table, a short-labels table, a
 * `switch` building the href and a `kind === "whatsapp" || kind === "email"` test for the
 * prefill — four places keyed on the same closed union, which is Fowler's Repeated Switches and
 * is also the shape that lets a fifth channel be added to three of them. Adding one here is a
 * single entry the compiler demands in full.
 *
 * `action` is the verb rather than the channel — `Escribir por WhatsApp`, not `WhatsApp` —
 * because the filled button is an instruction and the adopter is about to do the thing it names.
 * `Llamar` is the one that is not writing, and it earns its wording: a phone number offered as
 * "escribir" is a promise the channel cannot keep.
 *
 * `short` is held apart from `../shelter/fields.ts`'s `CONTACT_POINT_LABELS`, which labels the
 * *form a shelter fills in*. The two happen to agree today and are not the same string: that
 * table names the channel to the shelter that owns it, this one names an alternative to an
 * adopter choosing between them, and merging them would couple a public page's wording to a
 * private form's.
 */
interface Channel {
  /** What the filled button says. */
  readonly action: string;
  /** What the compact row says. */
  readonly short: string;
  /**
   * Whether the prefilled message travels on this channel.
   *
   * Data rather than a rule, because it is a fact about someone else's URL scheme: `wa.me` takes
   * a `?text=` and `mailto:` takes a `?body=`, while Instagram's web profile has no message
   * parameter at all and a phone call has no text.
   */
  readonly carriesPrefill: boolean;
  /**
   * The link, or `null` when this value cannot become one.
   *
   * Takes the whole hand-off's inputs rather than just the value, because `mailto:` needs the
   * animal's name for the subject line and the others do not — a signature per channel would be
   * a second thing to keep in step.
   */
  href(value: string, animalName: string, prefill: string): string | null;
}

const CHANNELS: Record<ContactPointKind, Channel> = {
  whatsapp: {
    action: "Escribir por WhatsApp",
    short: "WhatsApp",
    carriesPrefill: true,
    href(value, _animalName, prefill) {
      const digits = whatsappDigits(value);
      // `encodeURIComponent` rather than `URLSearchParams`, which writes `+` for a space: a
      // prefill reading `hace 4 meses` must not arrive as `hace+4+meses`.
      return digits === null
        ? null
        : `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`;
    },
  },
  instagram: {
    action: "Escribir por Instagram",
    short: "Instagram",
    carriesPrefill: false,
    href: (value) => instagramUrl(value),
  },
  email: {
    action: "Escribir un correo",
    short: "Correo",
    carriesPrefill: true,
    href: (value, animalName, prefill) => mailtoUri(value, animalName, prefill),
  },
  phone: {
    action: "Llamar",
    short: "Teléfono",
    carriesPrefill: false,
    href: (value) => telUri(value),
  },
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
 * The shortest string of digits that could be an international phone number.
 *
 * E.164 allows up to fifteen and sets no floor; eight is the shortest national number in
 * ordinary use plus a one- or two-digit country code. Below it the shelter has typed something
 * that is not a phone number, and a `wa.me` link built on it goes nowhere.
 */
const MIN_INTERNATIONAL_DIGITS = 8;

/**
 * A WhatsApp number as `wa.me` wants it — digits only, no `+`, no spaces — **or `null` when what
 * the shelter typed cannot become a working link.**
 *
 * A leading `00` is dropped first, because it is the international access prefix and `wa.me`
 * wants the country code bare: a shelter that typed `0058 412…` means the same number as one
 * that typed `+58 412…`.
 *
 * ## Why a leading zero is refused rather than repaired
 *
 * A Venezuelan shelter typing `0412 5550001` means `+58 412 5550001`, and this **will not guess
 * that**. `wa.me` takes E.164, in which a number never begins with `0` — the leading zero is a
 * national trunk prefix, meaningful only inside the country that defines it. So a number that
 * still starts with `0` after the `00` strip is a national format, and the only way to convert
 * it is to know that country's trunk rule: a per-country table the platform would then owe every
 * country it claims to work in (`CONTEXT.md`: "Built for Venezuelan shelters first, modelled to
 * work anywhere"). Guessing Venezuela's rule and applying it everywhere silently mangles
 * everyone else's numbers.
 *
 * **What it does instead is refuse, which is the whole point of this function returning `null`.**
 * The earlier version stripped the punctuation and handed back `04125550001`, producing a live
 * button to `wa.me/04125550001` that resolves to nothing — and an adopter who taps a dead link
 * concludes the animal is gone. Refusing renders the number as plain text beside the channel
 * name, so the adopter can still read it, copy it and dial it. A visible number beats an
 * invisible failure.
 *
 * The real fix is upstream, in the profile form (#52), where a shelter can be asked for the
 * international form and can see what it typed. This is the half that can be done from here.
 */
function whatsappDigits(value: string): string | null {
  const digits = value.replace(/\D/g, "").replace(/^00/, "");
  if (digits.length < MIN_INTERNATIONAL_DIGITS) return null;
  // E.164 has no leading zero; one that survives the `00` strip is a national trunk prefix.
  if (digits.startsWith("0")) return null;
  return digits;
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

/**
 * `tel:` keeps the `+`, which is the one character that makes a number dialable from abroad.
 *
 * **Deliberately more permissive than {@link whatsappDigits}**, and the asymmetry is real rather
 * than an oversight. `wa.me` resolves a number on WhatsApp's servers and needs E.164 or it
 * resolves nothing; `tel:` hands the string to the handset's dialler, and a Venezuelan adopter's
 * phone dials `0412 5550001` perfectly well — that is what a national number is *for*. Refusing
 * it here would break the common case in the name of a rule that does not apply.
 */
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
 * The first element is the one the page renders as a filled button — the shelter's own position
 * 0. That is not stated in the return type: a `{ first, rest }` shape was the alternative and it
 * lies about a shelter with one contact point, which would render an empty row.
 *
 * {@link ContactHandoff.carriesPrefill} is returned rather than left for the page to infer from
 * the kind, so the page can decide to show the quoted message only where some channel will
 * actually send it — without knowing anything about `wa.me`'s query string.
 */
export function contactHandoffs(
  points: readonly StoredContactPoint[],
  animalName: string,
  prefill: string,
): readonly ContactHandoff[] {
  return points.map((point) => {
    const channel = CHANNELS[point.kind];
    return {
      kind: point.kind,
      href: channel.href(point.value, animalName, prefill),
      label: channel.action,
      shortLabel: channel.short,
      value: point.value,
      carriesPrefill: channel.carriesPrefill,
    };
  });
}
