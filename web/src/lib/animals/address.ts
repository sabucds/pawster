/**
 * `/a/7f3k9mqp/luna` — where an animal lives, and the three forms that address is written in.
 *
 * One place, because an address written in two places is two addresses. The page builds its
 * own canonical link from here, the prefilled WhatsApp message quotes the same thing, and the
 * shelter's panel links to it; if any of them assembled the path itself, the day the shape
 * changed one of them would keep the old one.
 *
 * ## Only the id resolves
 *
 * The trailing segment is the animal's name as a slug and **nothing reads it**
 * ([ADR 0020](../../../../docs/adr/0020-an-animals-address-is-a-short-id-and-never-404s.md)).
 * It is there for the human who receives the link — `pawster.dpdns.org/a/7f3k9mqp` alone tells
 * a person nothing about what they are being sent — and it is decorative in the strong sense
 * that `/a/7f3k9mqp/cualquier-cosa` and `/a/7f3k9mqp` are the same page. Shelters rename
 * animals constantly, so any address that depended on the name would break weekly, and an
 * archive page that 404s is the one failure `CONTEXT.md`'s *Archive* rules out.
 *
 * That is also why the canonical link matters: the route answers to infinitely many spellings
 * of one address, and exactly one of them should be the one a search engine keeps.
 */

import { slugSegment } from "../slug.ts";

/**
 * The path, with the name as a slug when there is one to make.
 *
 * The transliteration is `../slug.ts`'s, reused rather than reimplemented because turning
 * `Ñoño` into `nono` is a rule with a table test and no reason to exist twice. `slugSegment()`
 * and not `slugify()`: that function answers `refugio` for a name that strips to nothing, which
 * is the right fallback for the shelter slug it was written for and names the wrong thing in an
 * animal's URL. Nothing to slug means no segment at all, and `/a/7f3k9mqp` is a perfectly good
 * address — which is the property this whole file rests on.
 */
export function animalPath(shortId: string, name: string): string {
  const slug = slugSegment(name);
  return slug.length === 0 ? `/a/${shortId}` : `/a/${shortId}/${slug}`;
}

/** The absolute address, for a canonical link and for the social preview tags. */
export function animalUrl(siteOrigin: string, shortId: string, name: string): string {
  return `${siteOrigin.replace(/\/+$/, "")}${animalPath(shortId, name)}`;
}

/**
 * The address as it reads inside a message a shelter receives — `pawster.dpdns.org/a/7f3k9mqp`.
 *
 * No scheme, because a bare host reads as something a person typed and `https://` reads as
 * something a machine pasted; every mail client and WhatsApp itself will linkify it anyway.
 * **No name slug either**, and that is the more deliberate of the two omissions: the message
 * already names the animal in words directly before this, so the slug would repeat it, and the
 * shorter the address the likelier it survives being retyped off a screenshot.
 */
export function messageAddress(siteOrigin: string, shortId: string): string {
  const host = siteOrigin.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `${host}/a/${shortId}`;
}
