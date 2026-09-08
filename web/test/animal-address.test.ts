import { describe, expect, it } from "vitest";
import {
  animalPath,
  animalUrl,
  messageAddress,
} from "../src/lib/animals/address.ts";
import {
  SHORT_ID_ALPHABET,
  SHORT_ID_LENGTH,
  isShortIdShaped,
  newShortId,
} from "../src/lib/animals/short-id.ts";

/**
 * The address an animal keeps forever, as a table.
 *
 * Pure — no Worker, no clock, no database. `crypto.getRandomValues` is a global rather than a
 * binding, so even {@link newShortId} runs here with nothing supplied to it.
 */

describe("the short id", () => {
  it("holds none of the four characters a human transcribes wrong", () => {
    // `0`/`o` and `1`/`l` are the two pairs that get retyped wrong off a screenshot, and this
    // id is retyped off screenshots — it travels inside a WhatsApp message.
    for (const ambiguous of ["0", "1", "l", "o"]) {
      expect(SHORT_ID_ALPHABET).not.toContain(ambiguous);
    }
  });

  it("is exactly a byte's low five bits wide, so there is no modulo bias", () => {
    // 32 symbols is what makes `byte & 31` uniform. A 62-symbol alphabet would need rejection
    // sampling, and the version without it is the quiet bug this asserts against.
    expect(SHORT_ID_ALPHABET).toHaveLength(32);
    expect(new Set(SHORT_ID_ALPHABET).size).toBe(32);
  });

  it("mints ids of the declared shape", () => {
    for (let i = 0; i < 200; i++) {
      const id = newShortId();
      expect(id).toHaveLength(SHORT_ID_LENGTH);
      expect(isShortIdShaped(id)).toBe(true);
    }
  });

  it("mints a different one every time", () => {
    // Not a collision test — 200 draws from 1.1e12 says nothing about the birthday bound, and
    // `scripts/measure-short-id.mjs` is where that arithmetic lives. This catches the version
    // that returns a constant, which is the failure a distribution test would not notice.
    const ids = new Set(Array.from({ length: 200 }, newShortId));
    expect(ids.size).toBe(200);
  });

  it("rejects the shapes it does not mint", () => {
    expect(isShortIdShaped("")).toBe(false);
    expect(isShortIdShaped("7f3k")).toBe(false);
    expect(isShortIdShaped("7f3k9mqpx")).toBe(false);
    // Upper case is a second spelling of one address, which is the thing the alphabet avoids.
    expect(isShortIdShaped("7F3K9MQP")).toBe(false);
    expect(isShortIdShaped("7f3k9mq0")).toBe(false);
  });
});

describe("the path an animal lives at", () => {
  it("carries the name as a decorative slug", () => {
    expect(animalPath("7f3k9mqp", "Luna")).toBe("/a/7f3k9mqp/luna");
  });

  it("transliterates the name the way the shelter slug does", () => {
    // Reused rather than reimplemented: `Ñoño` → `nono` is a rule with a table test in
    // `slug.test.ts`, and a second copy would be a second set of URLs to be wrong in.
    expect(animalPath("7f3k9mqp", "Ñoño")).toBe("/a/7f3k9mqp/nono");
    expect(animalPath("7f3k9mqp", "Mora, Nube y Panita")).toBe(
      "/a/7f3k9mqp/mora-nube-y-panita",
    );
  });

  it("omits the segment for a name that transliterates to nothing", () => {
    /**
     * `slugify()` would answer `refugio` here, which is the right fallback for the shelter slug
     * it was written for and names the wrong thing entirely in an animal's URL. Nothing to slug
     * means no segment, and the id alone is a complete address.
     */
    expect(animalPath("7f3k9mqp", "🐕")).toBe("/a/7f3k9mqp");
    expect(animalPath("7f3k9mqp", "   ")).toBe("/a/7f3k9mqp");
  });

  it("keeps the address when the animal is renamed", () => {
    // The property the whole design rests on: shelters rename animals constantly, and only the
    // decorative segment moves.
    const before = animalPath("7f3k9mqp", "Callejero");
    const after = animalPath("7f3k9mqp", "Luna");
    expect(before).not.toBe(after);
    expect(before.split("/")[2]).toBe(after.split("/")[2]);
  });

  it("builds an absolute url without doubling the slash", () => {
    expect(animalUrl("https://pawster.test", "7f3k9mqp", "Luna")).toBe(
      "https://pawster.test/a/7f3k9mqp/luna",
    );
    expect(animalUrl("https://pawster.test/", "7f3k9mqp", "Luna")).toBe(
      "https://pawster.test/a/7f3k9mqp/luna",
    );
  });
});

describe("the address as a message reads it", () => {
  it("drops the scheme, so it reads as something a person typed", () => {
    expect(messageAddress("https://pawster.test", "7f3k9mqp")).toBe(
      "pawster.test/a/7f3k9mqp",
    );
  });

  it("drops the name too, because the message already said it", () => {
    // The sentence around this names the animal in words directly before it, so the slug would
    // repeat it — and the shorter the address, the likelier it survives being retyped.
    expect(messageAddress("https://pawster.test", "7f3k9mqp")).not.toContain(
      "luna",
    );
  });
});
