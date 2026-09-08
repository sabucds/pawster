import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_NAME, MAX_FIELD } from "../src/lib/shelter/fields.ts";
import {
  LAST_CONTACT_POINT_REASON,
  parseAccountEmailChange,
  parseProfile,
} from "../src/lib/shelter/profile.ts";

/**
 * The profile forms as pure functions: `FormData` in, values or reasons out.
 *
 * No Worker, no database, no clock — which is the whole reason the parsing lives apart from
 * the pages. The two rules worth testing here are the ones a shelter's animals depend on and
 * that would otherwise only be reachable by posting a form: **the order the contact points
 * come back in**, and **that the last one cannot be removed**.
 */

/** One form, from repeated controls in document order, the way a browser submits them. */
function form(fields: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value as string]) {
      data.append(name, item);
    }
  }
  return data;
}

const FILLED = {
  displayName: "Refugio Los Teques",
  baseRegion: "Miranda",
};

describe("parseProfile", () => {
  it("returns the contact points in the order the shelter numbered them", () => {
    const parsed = parseProfile(
      form({
        ...FILLED,
        contactPosition: ["3", "1", "2"],
        contactKind: ["email", "whatsapp", "instagram"],
        contactValue: ["hola@refugio.example", "+58 412 5550001", "@refugio"],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    /**
     * WhatsApp first because the shelter numbered it 1, not because it was submitted second
     * and not because of the order of `CONTACT_POINT_KINDS`. The first element is the one an
     * adopter is offered as a filled button, so this list *is* the decision.
     */
    expect(parsed.value.contactPoints).toEqual([
      { kind: "whatsapp", value: "+58 412 5550001" },
      { kind: "instagram", value: "@refugio" },
      { kind: "email", value: "hola@refugio.example" },
    ]);
  });

  it("falls back to document order when no positions are submitted", () => {
    // The registration form's shape: three rows, no `contactPosition` control at all. Its
    // rows are already in the order they appear on screen, so that is the order to keep.
    const parsed = parseProfile(
      form({
        ...FILLED,
        contactKind: ["whatsapp", "instagram"],
        contactValue: ["+58 412 5550001", "@refugio"],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.contactPoints.map((point) => point.kind)).toEqual([
      "whatsapp",
      "instagram",
    ]);
  });

  it("breaks a tie on document order rather than refusing a duplicate number", () => {
    /**
     * A typed number's failure mode, handled rather than validated. A shelter that types the
     * same number twice has expressed something well-defined enough to act on, and showing it
     * an error about numbering would be the form talking about itself.
     */
    const parsed = parseProfile(
      form({
        ...FILLED,
        contactPosition: ["2", "1", "1"],
        contactKind: ["email", "whatsapp", "instagram"],
        contactValue: ["hola@refugio.example", "+58 412 5550001", "@refugio"],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.contactPoints.map((point) => point.kind)).toEqual([
      "whatsapp",
      "instagram",
      "email",
    ]);
  });

  it("drops a blank row instead of refusing it, because that is how one is deleted", () => {
    const parsed = parseProfile(
      form({
        ...FILLED,
        contactPosition: ["1", "2", "3"],
        contactKind: ["whatsapp", "instagram", "email"],
        // The middle row emptied: the shelter is removing its Instagram. The blank row's
        // number is not a gap it has to fix, because position is the index in the result.
        contactValue: ["+58 412 5550001", "  ", ""],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.contactPoints).toEqual([
      { kind: "whatsapp", value: "+58 412 5550001" },
    ]);
  });

  it("refuses to remove the last contact point, and says what would happen", () => {
    const parsed = parseProfile(
      form({
        ...FILLED,
        contactPosition: ["1", "2"],
        contactKind: ["whatsapp", "instagram"],
        contactValue: ["", ""],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      { field: "contactPoints", reason: LAST_CONTACT_POINT_REASON },
    ]);
    /**
     * The message names the consequence and not the rule. `isListed()` has a
     * `contactPointCount > 0` clause, so emptying the last row delists every animal the
     * shelter has already published — silently, through a rule it never saw, with nothing on
     * this page looking wrong afterwards.
     */
    expect(LAST_CONTACT_POINT_REASON).toContain("dejan de aparecer");
  });

  it("reports every problem at once rather than the first one", () => {
    const parsed = parseProfile(
      form({
        displayName: "",
        baseRegion: "",
        contactKind: ["whatsapp"],
        contactValue: [""],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.field)).toEqual([
      "displayName",
      "baseRegion",
      "contactPoints",
    ]);
  });

  it("refuses a kind that is not one of the four channels", () => {
    // Unreachable from the form, whose control is a `<select>`, so it can only come from a
    // hand-made request — which is exactly why it is rejected rather than dropped.
    const parsed = parseProfile(
      form({
        ...FILLED,
        contactKind: ["telegram"],
        contactValue: ["@refugio"],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors[0]!.field).toBe("contactPoints");
  });

  it("bounds the fields it accepts", () => {
    const parsed = parseProfile(
      form({
        displayName: "x".repeat(MAX_DISPLAY_NAME + 1),
        baseRegion: "y".repeat(MAX_FIELD + 1),
        contactKind: ["whatsapp"],
        contactValue: ["z".repeat(MAX_FIELD + 1)],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.field)).toEqual([
      "displayName",
      "baseRegion",
      "contactPoints",
    ]);
  });

  it("reads no slug, whatever a hand-made request sends", () => {
    /**
     * The parser has no `slug` field, so a request carrying one is not refused — it is simply
     * not looked at. Asserted on the parse result because that is the only place a slug could
     * have got in: `ProfileInput` has no such property and `saveShelterProfile()` cannot
     * write one.
     */
    const parsed = parseProfile(
      form({
        ...FILLED,
        slug: "refugio-secuestrado",
        contactKind: ["whatsapp"],
        contactValue: ["+58 412 5550001"],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual([
      "baseRegion",
      "contactPoints",
      "displayName",
    ]);
  });
});

describe("parseAccountEmailChange", () => {
  it("accepts an address typed twice, normalising both", () => {
    const parsed = parseAccountEmailChange(
      form({
        accountEmail: "  Nuevo@Refugio.Example ",
        accountEmailAgain: "nuevo@refugio.example",
      }),
    );

    expect(parsed).toEqual({ ok: true, value: "nuevo@refugio.example" });
  });

  it("refuses two addresses that differ", () => {
    /**
     * The one mistake on this form that has no undo: the new address is the only thing that
     * can authenticate the shelter afterwards, so a typo is an account nobody can reach and
     * ADR 0013 answers it out of band. A confirmation field costs one input.
     */
    const parsed = parseAccountEmailChange(
      form({
        accountEmail: "nuevo@refugio.example",
        accountEmailAgain: "nuevo@refugio.exampl",
      }),
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("no son iguales");
  });

  it("refuses an address that is not one, and an empty one", () => {
    for (const value of ["", "sin-arroba", "dos@@arrobas.example", "sin@dominio"]) {
      const parsed = parseAccountEmailChange(
        form({ accountEmail: value, accountEmailAgain: value }),
      );
      expect(parsed.ok, `"${value}" should be refused`).toBe(false);
    }
  });
});
