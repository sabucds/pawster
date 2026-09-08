/**
 * The animal's whole public address, and the only part of `/a/7f3k/luna` that resolves.
 *
 * `../animals/store.ts` already recorded why the id is minted at publication rather than
 * passed in — "it is the animal's whole public address [...] and a caller that chose it would
 * be the second place that address was decided". This file is the other half of that sentence:
 * *what* the address looks like, held apart from the insert that spends it so the shape is a
 * table test rather than something only reachable through a database.
 *
 * ## Why it is short, and why the name beside it is decorative
 *
 * A public address is `/a/<id>/<name>` with **only the id resolving**
 * ([ADR 0020](../../../../docs/adr/0020-an-animals-address-is-a-short-id-and-never-404s.md)).
 * The name in the path is a slug for a human reading a pasted link and nothing else, because
 * shelters rename animals constantly — a Callejero that becomes a Luna keeps its address, and
 * every WhatsApp forward of the old link still lands. An address that resolved on the name
 * would break on the first rename, which on this platform is a weekly event.
 *
 * That makes the id the thing an adopter reads aloud, retypes off a screenshot and sees inside
 * the prefilled message the shelter receives. A UUID is 36 characters of that, and the
 * prefill — `Hola, les escribo por Luna (pawster.dpdns.org/a/7f3kq9mp)` — is where the cost
 * shows: the address is *in the message a stranger sends*, so its length is a legibility
 * property rather than a storage one.
 *
 * ## The alphabet
 *
 * Lower-case digits and letters minus `0`, `1`, `l` and `o`, which is 32 symbols. The four are
 * dropped because this id is transcribed by humans off screenshots, and `l`/`1` and `0`/`O` are
 * the two pairs that get transcribed wrong. Lower-case throughout, so there is no case to get
 * wrong either, and so the id cannot look like two different addresses in a URL bar that
 * lower-cases what it displays.
 *
 * It is **not** Crockford base32: that alphabet includes `0` and `1` and resolves the confusion
 * by *decoding* `O` to `0`, which would make two spellings of one address. Two spellings of an
 * immutable address is the thing this file exists to avoid.
 *
 * 32 symbols is also exactly a byte's low five bits, so `byte & 31` is uniform and there is no
 * rejection sampling to get subtly wrong — a modulo over a 62-symbol alphabet is the usual
 * quiet bias here.
 *
 * ## The length, and the arithmetic behind it
 *
 * Eight symbols is 32^8 ≈ 1.1 × 10^12 addresses. Run `npm run check:short-id` for the figures;
 * the two that decided it are that at 10,000 animals — four times the 2,500 the filter-index
 * measurements assume — one publish collides with probability ~9 × 10^-9, and the chance of
 * *any* collision across the platform's whole life at that size is ~4 × 10^-5.
 *
 * So the primary key is the guard and there is no retry loop, deliberately: a collision is
 * several orders of magnitude rarer than the D1 write failing for an unrelated reason, and a
 * retry path that runs once a millennium is a path that is wrong when it finally runs. A
 * collision surfaces as the insert failing, which is a publish the shelter can repeat.
 *
 * Guessability is **not** what sets the length, and it is worth saying so, because every other
 * random value on this platform is sized against an attacker. This one is not: an animal page
 * is public and the listing enumerates it anyway, so there is nothing behind the address to
 * guess your way into. 8 was chosen against collisions and against a human retyping it.
 */

/**
 * 32 symbols: `0`, `1`, `l` and `o` are absent, and the five bits of a random byte index it
 * exactly.
 */
export const SHORT_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

/** Eight symbols — see the arithmetic above, and `scripts/measure-short-id.mjs`. */
export const SHORT_ID_LENGTH = 8;

/**
 * A fresh public address.
 *
 * `crypto.getRandomValues` rather than `Math.random`, not because this needs to be
 * unguessable but because `Math.random` makes no promise about its distribution and a biased
 * address space is a collision rate that does not match the arithmetic above.
 */
export function newShortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_ID_LENGTH));
  let id = "";
  for (const byte of bytes) id += SHORT_ID_ALPHABET[byte & 31];
  return id;
}

/**
 * **There is deliberately no `isShortIdShaped()` here**, and the absence is worth a note because
 * the function is the obvious next thing to write.
 *
 * Nothing would call it. The route does not validate the segment before looking it up: an id
 * that misses is the same 404 as an id that could not have existed, so a shape check ahead of
 * the query buys nothing and costs a second code path that can disagree with the first about
 * what an address is. And it must not become one — animals published before this file existed
 * carry UUIDs, and a route that refused anything not eight symbols long would 404 every one of
 * them. `web/test/animal-address.test.ts` asserts the shape of what {@link newShortId} mints,
 * which is the only place the question is actually asked.
 */
