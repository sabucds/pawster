/**
 * Turning a shelter's display name into the identifier its URLs keep forever.
 *
 * The slug is generated once, at registration, and never rewritten — see
 * `shelters.slug` in `db/src/schema.ts` for why. That immutability is what makes this
 * function's output matter more than it looks: it runs once per shelter in the platform's
 * life, and whatever it returns is an address adopters and search engines will hold.
 *
 * Pure, and separate from the query that reserves it, so the transliteration rules below
 * are a table test rather than something only reachable through a database.
 */

/**
 * Long enough for `fundacion-protectora-de-animales-de-caracas` (43) and every other name
 * on the map, short enough that a slug stays readable in a shared link. A name longer than
 * this is truncated at a word boundary rather than mid-word, because a slug cut to
 * `refugio-los-teq` reads as a typo.
 */
const MAX_SLUG_LENGTH = 60;

/**
 * Slugs the platform will not hand out, because a shelter holding one would shadow a route.
 *
 * This list is the reason slug generation is not a one-line regex. `/refugios/registro` and
 * `/refugios/entrar` are real paths under the same prefix a shelter's own page will live at,
 * so a shelter that called itself "Registro" would take an address the platform had already
 * spent. Caught here, at the only moment the slug is chosen, rather than by hoping the two
 * namespaces never meet.
 *
 * Deliberately short: it holds the segments that exist today plus the two an authenticated
 * area obviously grows. Adding a route under `/refugios/` means adding it here, and
 * `slug.test.ts` is where that is asserted rather than assumed.
 */
const RESERVED_SLUGS = new Set([
  "registro",
  "entrar",
  "salir",
  "panel",
  "api",
  "cuenta",
  "verificacion",
]);

/**
 * The fallback stem for a name that transliterates to nothing at all — a display name made
 * only of emoji or of a script this strips. Rare to the point of hypothetical, and it still
 * needs an answer, because the alternative is a registration that fails on a name the
 * shelter is entitled to use. It publishes under its display name either way; only the URL
 * is affected.
 */
const FALLBACK_STEM = "refugio";

/**
 * A display name reduced to its slug stem, before collisions are resolved.
 *
 * Accents are stripped by NFD decomposition rather than by a character map, which is what
 * makes `Fundación` and `Añañá` work without a table: NFD splits `ó` into `o` plus a
 * combining acute, and the acute is then removed as a combining mark. `ñ` decomposes the
 * same way, so it becomes `n` — the conventional Spanish URL spelling, and the one a
 * shelter typing its own name into a search box would use.
 *
 * The one letter this deliberately does not handle specially is `ü` in `Camagüey`, which
 * becomes `u` by the same rule and is correct.
 */
export function slugify(displayName: string): string {
  const stem = slugSegment(displayName);
  if (stem.length === 0) return FALLBACK_STEM;
  return stem;
}

/**
 * The same transliteration, but **empty where there was nothing to transliterate** — no
 * fallback stem.
 *
 * The half of {@link slugify} that an animal's address needs (`../lib/animals/address.ts`).
 * `/a/7f3k9mqp/luna` carries the animal's name as a decorative segment, and for a name that
 * strips to nothing the honest answer is to omit the segment: `refugio` is the right fallback
 * for the shelter slug this file was written for, and in an animal's URL it names the wrong
 * thing entirely.
 *
 * Exported rather than inlined at that call site because the rules above — NFD decomposition
 * over a character map, the deny-list of allowed characters, truncation at a word boundary —
 * are a table test, and a second copy of them would be a second set of URLs to be wrong in.
 */
export function slugSegment(displayName: string): string {
  const stem = displayName
    .normalize("NFD")
    // Every combining mark, i.e. the accents NFD has just separated out. The Unicode
    // property escape rather than a literal `̀-ͯ` range, because the characters
    // in that range render as nothing in a diff and an editor that renormalises the file
    // would silently eat them — leaving a regex that still compiles and matches nothing.
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Everything that is not an unaccented letter or digit becomes a separator. Written as
    // a denylist of the allowed set rather than a list of punctuation, so a character
    // nobody thought of becomes a hyphen instead of surviving into a URL.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (stem.length === 0) return "";
  return truncateAtWordBoundary(stem, MAX_SLUG_LENGTH);
}

function truncateAtWordBoundary(stem: string, limit: number): string {
  if (stem.length <= limit) return stem;
  const cut = stem.slice(0, limit);
  const lastHyphen = cut.lastIndexOf("-");
  // Fall back to the hard cut when the first "word" is itself longer than the limit; there
  // is no boundary to prefer in that case.
  return lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut;
}

/**
 * The ordered candidates to try for one display name.
 *
 * A generator rather than a list, because the common case draws exactly one value and
 * building a hundred strings to use the first is waste on a request that already has a
 * database round trip to make.
 *
 * The first candidate is the bare stem; a stem that is reserved skips straight to `-2`,
 * which is why the reserved check lives here rather than in `slugify()` — `registro` is a
 * perfectly good *stem*, it just cannot be the whole slug. Numbering starts at 2 because
 * `refugio-los-teques-1` implies a `refugio-los-teques-0` that does not exist.
 */
export function* slugCandidates(displayName: string): Generator<string> {
  const stem = slugify(displayName);
  if (!RESERVED_SLUGS.has(stem)) yield stem;
  for (let suffix = 2; ; suffix++) {
    yield `${stem}-${suffix}`;
  }
}

/** Whether a slug is one the platform keeps for itself. Exported for the route tests. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
