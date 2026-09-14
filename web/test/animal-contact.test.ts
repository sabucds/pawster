import type { ContactPointKind } from "@pawster/db";
import { describe, expect, it } from "vitest";
import {
  contactHandoffs,
  prefillMessage,
} from "../src/lib/animals/contact.ts";
import type { StoredContactPoint } from "../src/lib/shelter/store.ts";

/**
 * The hand-off, as a table.
 *
 * Every value below is *shelter-typed and unvalidated beyond its length* — `../src/lib/shelter/
 * fields.ts` checks the kind and the length and nothing else — so this table is the whole of
 * what stands between what a shelter typed into its profile and a link an adopter taps.
 */

const PREFILL = prefillMessage("Canela", "pawster.test/a/7f3k9mqp");

function handoff(kind: ContactPointKind, value: string) {
  const points: StoredContactPoint[] = [{ kind, value }];
  return contactHandoffs(points, "Canela", PREFILL)[0]!;
}

describe("the prefilled message", () => {
  it("names the animal and its short id", () => {
    /**
     * The acceptance criterion, and the sentence the whole short id exists for: contact is
     * off-platform, so this is the only thing that tells a shelter which of its forty animals a
     * stranger's message is about. A name alone cannot — a shelter with two Lunas, or one that
     * renamed this animal last week, cannot resolve it.
     */
    expect(PREFILL).toContain("Canela");
    expect(PREFILL).toContain("pawster.test/a/7f3k9mqp");
    expect(PREFILL).toBe(
      "Hola, les escribo por Canela (pawster.test/a/7f3k9mqp). ¿Sigue disponible?",
    );
  });
});

describe("WhatsApp", () => {
  it("carries the prefill in the link", () => {
    const whatsapp = handoff("whatsapp", "+58 412 5550001");

    expect(whatsapp.href).toBe(
      `https://wa.me/584125550001?text=${encodeURIComponent(PREFILL)}`,
    );
    expect(whatsapp.carriesPrefill).toBe(true);
  });

  it("encodes a space as %20 and not as +", () => {
    /**
     * `URLSearchParams` writes `+` for a space, which is correct in a form-encoded query string
     * and arrives in the WhatsApp composer as a literal plus. The message would read
     * `Hola,+les+escribo+por+Canela`, which is the failure this asserts against.
     */
    expect(handoff("whatsapp", "+58 412 5550001").href).toContain("Hola%2C%20les");
    expect(handoff("whatsapp", "+58 412 5550001").href).not.toContain("+les");
  });

  it("strips everything wa.me will not take", () => {
    expect(handoff("whatsapp", "+58 412 555-0001").href).toContain("wa.me/584125550001?");
    // The international access prefix: `0058 412…` is the same number as `+58 412…`.
    expect(handoff("whatsapp", "0058 412 5550001").href).toContain("wa.me/584125550001?");
  });

  it("refuses a nationally-formatted number instead of linking to nothing", () => {
    /**
     * The common case for a Venezuelan shelter, and the one that used to produce a live button
     * to `wa.me/04125550001` — a link that resolves to nothing, on a page whose whole purpose is
     * to be written to. An adopter who taps a dead link concludes the animal is gone.
     *
     * `wa.me` takes E.164, in which a number never begins with `0`: a leading zero is a national
     * trunk prefix. Converting it means owning a trunk rule per country, so the platform refuses
     * instead and the page prints the number as text the adopter can read and dial.
     */
    expect(handoff("whatsapp", "0412 5550001").href).toBeNull();
    expect(handoff("whatsapp", "(0212) 555-0001").href).toBeNull();
  });

  it("still dials a national number on the phone channel", () => {
    // The asymmetry is real: `tel:` hands the string to the handset's dialler, and a national
    // number is exactly what a local handset dials.
    expect(handoff("phone", "0412 5550001").href).toBe("tel:04125550001");
  });

  it("has no link for a value that is not a number at all", () => {
    expect(handoff("whatsapp", "pregúntanos").href).toBeNull();
    // Too short to be any country's number, so it cannot become a working link either.
    expect(handoff("whatsapp", "5550").href).toBeNull();
  });
});

describe("the other three channels", () => {
  it("takes an Instagram handle however the shelter wrote it", () => {
    expect(handoff("instagram", "@refugiolosteques").href).toBe(
      "https://instagram.com/refugiolosteques",
    );
    expect(handoff("instagram", "refugiolosteques").href).toBe(
      "https://instagram.com/refugiolosteques",
    );
    expect(handoff("instagram", "instagram.com/refugiolosteques/").href).toBe(
      "https://instagram.com/refugiolosteques",
    );
    // A pasted URL is left alone rather than parsed down and rebuilt: it already works, and
    // rebuilding it would drop whatever it carried that this does not know about.
    expect(handoff("instagram", "https://www.instagram.com/refugio?hl=es").href).toBe(
      "https://www.instagram.com/refugio?hl=es",
    );
  });

  it("carries the prefill in a mailto body, and names the animal in the subject", () => {
    const email = handoff("email", "adopciones@refugio.example");

    expect(email.carriesPrefill).toBe(true);
    expect(email.href).toContain("mailto:adopciones@refugio.example?");

    /**
     * Decoded rather than compared as a string, because there is more than one correct
     * encoding — `URLSearchParams` percent-encodes `(` where `encodeURIComponent` leaves it —
     * and asserting one of them would be asserting the implementation rather than the message.
     */
    const query = new URLSearchParams(email.href!.split("?")[1]);
    expect(query.get("subject")).toBe("Adopción de Canela");
    expect(query.get("body")).toBe(PREFILL);

    // The `+`-as-space trap: correct in a form-encoded query and rendered literally in a body
    // by several clients, so the message would arrive reading `Hola,+les+escribo`.
    expect(email.href).not.toContain("+");
  });

  it("keeps the plus on a phone number, which is what makes it dialable abroad", () => {
    expect(handoff("phone", "+58 212 555 0001").href).toBe("tel:+582125550001");
  });

  it("promises no prefill on the channels that cannot carry one", () => {
    /**
     * Instagram's profile URL has no message parameter and a phone call has no text. The page
     * reads this rather than the kind, so a shelter reachable only on Instagram is not shown a
     * quoted message that will never arrive.
     */
    expect(handoff("instagram", "@refugio").carriesPrefill).toBe(false);
    expect(handoff("phone", "+58 212 555 0001").carriesPrefill).toBe(false);
  });

  it("has no link for a value that is not an address at all", () => {
    expect(handoff("email", "escríbenos").href).toBeNull();
    expect(handoff("phone", "el timbre").href).toBeNull();
    expect(handoff("instagram", "@").href).toBeNull();
  });
});

describe("the order", () => {
  it("is the shelter's own, because position 0 is the channel it answers", () => {
    /**
     * `CONTEXT.md`, *Contact Point*: the order is a decision the shelter makes, and "the first
     * one is what an adopter is offered as a filled button". Sorting or grouping by kind here
     * would silently overrule a shelter that put WhatsApp first precisely because it merely owns
     * the Instagram account.
     */
    const points: StoredContactPoint[] = [
      { kind: "whatsapp", value: "+58 412 5550001" },
      { kind: "instagram", value: "@refugio" },
      { kind: "email", value: "hola@refugio.example" },
    ];

    expect(contactHandoffs(points, "Canela", PREFILL).map((c) => c.kind)).toEqual([
      "whatsapp",
      "instagram",
      "email",
    ]);
  });

  it("returns a flat list rather than a primary and a rest", () => {
    // A `{ primary, rest }` shape lies about a shelter with one contact point, which has a
    // primary and no rest and would render an empty row.
    expect(contactHandoffs([], "Canela", PREFILL)).toEqual([]);
    expect(
      contactHandoffs([{ kind: "whatsapp", value: "+58 412 5550001" }], "Canela", PREFILL),
    ).toHaveLength(1);
  });
});
