/**
 * The filter index: what a listed animal looks like on the wire, and the three rules the
 * listing reads it through.
 *
 * `CONTEXT.md` calls it "the single compact file carrying, for every listed animal, the axes
 * an adopter filters on and the fields its card shows", and
 * [ADR 0018](../../docs/adr/0018-the-filter-index-is-rewritten-whole-and-found-through-a-pointer.md)
 * settles how it is written and found. What lives here is the half that is neither I/O nor
 * markup: the shape, the encoding, the ordering, and the prefix-keeping rule.
 *
 * It is in `domain/` because the regenerator writes this shape and the browser island reads
 * it, and a wire format stated twice is a wire format that will eventually disagree with
 * itself — over exactly the field nobody thought to test.
 *
 * ## It carries the two dates and never a band
 *
 * `estimatedBirthDate` and `lastConfirmedAt`, and neither of the bands derived from them.
 * A stored band freezes at the moment the file was written, so a dog crossing from `Puppy`
 * into `Young` would re-band only when someone happened to republish it — reintroducing the
 * invisible scheduled writer [ADR 0004](../../docs/adr/0004-age-bands-are-derived.md) exists
 * to avoid. {@link ListedAnimal} therefore has no band field, and there is no encoding for
 * one to slip in through: the wire shape below is a closed set of keys.
 *
 * ## Single-letter keys, because the measurement was taken over them
 *
 * The compact shape is not a micro-optimisation reached for on instinct. The issue #17
 * prototype measured the index at **141 B/animal raw and 33.4 KB gzipped at 2,500 animals**
 * over exactly these keys and exactly these encodings, and ADR 0018 spends those figures —
 * they are what establish that the index never becomes the binding constraint ahead of R2's
 * 10 GB. Shipping a different shape would leave the ADR quoting numbers that describe
 * nothing. `scripts/measure-filter-index.mjs` re-derives them from {@link serializeIndex}
 * itself, so the figures stay reproducible from the code that actually writes the file.
 *
 * The keys are contained by this module and no consumer sees them: everything outside reads
 * {@link ListedAnimal}, whose fields are spelled out. That is the trade — one file that is
 * terse on purpose, and nothing else that has to be.
 *
 * Two encodings are cheaper here than in the prototype, in the same direction, so its
 * figure remains a ceiling: a cat's absent size and an unmarked animal's urgency are
 * *omitted* rather than written as `0`.
 */

import type {
  GoodWithAxis,
  GoodWithFlag,
  GoodWithFlags,
  Region,
  Sex,
  Size,
  Species,
} from "./axes.ts";
import { GOOD_WITH_AXES } from "./axes.ts";
import { normaliseRegion } from "./criteria.ts";
import type { AnimalAxes, SubscriptionCriteria } from "./matching.ts";
import { matches } from "./matching.ts";

/**
 * One listed animal as the index carries it.
 *
 * **A structural superset of `AnimalAxes`**, which is the point rather than a coincidence:
 * `matching.ts` promises that its projection is "near enough the set ADR 0007 puts in the
 * filter index, which is what lets the browser island hand its parsed index entries straight
 * to `matches`". This is that promise cashed — every field `AnimalAxes` requires is here
 * under the same name and the same type, so the island filters with the digest matcher's own
 * function and no adapter in between.
 *
 * The four fields beyond the axes are the card's, and they are the whole of what the card's
 * field budget bought (#17): the thumbnail it shows, the group it belongs to, whether it
 * carries the urgency mark, and which shelter published it.
 */
export interface ListedAnimal {
  readonly id: string;
  readonly name: string;
  readonly species: Species;
  readonly region: Region;
  /** `null` for a cat: size is asked of dogs only. */
  readonly size: Size | null;
  readonly sex: Sex;
  /** The estimate, never a band derived from it (ADR 0004). */
  readonly estimatedBirthDate: Date;
  /** The other date, from which staleness is derived at read time (ADR 0001). */
  readonly lastConfirmedAt: Date;
  readonly goodWith: GoodWithFlags;
  /** The `d/` key of the primary photo's card derivative. */
  readonly thumbnailKey: string;
  /** The bonded group this animal is adopted with, or `null` for a lone animal. */
  readonly bondedGroupId: string | null;
  /**
   * Whether the animal carries the urgency mark. A boolean and not the reason: the reason is
   * high-entropy free text that the prototype measured at +8 B/animal, and it is read on the
   * animal page rather than the card (#17).
   */
  readonly urgent: boolean;
  /**
   * The shelter's id, and never its name. Verification is a precondition for listing, so
   * every listed animal's shelter is verified and the name changes no shortlisting decision —
   * while inlining it costs 37 B/animal (#17).
   */
  readonly shelterId: string;
}

/**
 * The index as a whole: a `generatedAt` and the animals, in id order.
 *
 * `generatedAt` is inside the hashed bytes, which sounds wrong for a content-addressed
 * object and is not: it is the *listable set's* stamp, not the run's. Two regenerations over
 * an unchanged catalogue must produce identical bytes or ADR 0018's free nightly no-op
 * becomes a nightly write plus an orphan — so this field carries the moment the D1 read was
 * taken **rounded to the day**, which is stable across a day's worth of no-op runs and still
 * tells a reader roughly how old the file it is holding is. The pointer carries the precise
 * instant, and the pointer is expected to change every run.
 */
export interface FilterIndex {
  readonly generatedAt: string;
  readonly animals: readonly ListedAnimal[];
}

/**
 * The prefix the index and its pointer live under in `pawster-media`.
 *
 * Deliberately outside `d/`, which is
 * [ADR 0016](../../docs/adr/0016-unreferenced-derivatives-are-reclaimed-by-reconciliation.md)'s
 * entire reclamation scope: the nightly sweep lists `d/` and never the bucket root, so
 * nothing here is a delete candidate. This prefix is kept by its own writer instead — see
 * {@link isSupersededIndexObject}.
 */
export const INDEX_PREFIX = "i/";

/**
 * The one mutable, uncacheable object in the read path: about a hundred bytes naming the
 * index a reader should fetch.
 *
 * It exists because the index never changes underneath anyone. The pointer is the only thing
 * that moves, which is what leaves nothing anywhere needing to be invalidated — no cache
 * purge exists in the publish path (ADR 0018).
 */
export const INDEX_POINTER_KEY = `${INDEX_PREFIX}current.json`;

/**
 * What the pointer holds. `generatedAt` is the precise instant of the run, so the pointer's
 * own bytes change every night even when the index's do not — which is why ADR 0018 makes
 * *the key*, and never the pointer, the drift signal.
 */
export interface IndexPointer {
  readonly key: string;
  readonly generatedAt: string;
}

/**
 * A year, and `immutable`, exactly as a derivative is served
 * ([ADR 0012](../../docs/adr/0012-derivatives-are-generated-once-at-upload.md)). Safe to the
 * point of being uninteresting *because* the key is the content: the bytes behind it cannot
 * change, so there is nothing a stale cache could be stale about.
 */
export const INDEX_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The pointer is never cached. Under `r2.dev` this is a statement of intent rather than a
 * knob — ADR 0014 records that it caches nothing at all — and it becomes load-bearing behind
 * the cached Worker that replaces it.
 */
export const POINTER_CACHE_CONTROL = "no-store";

/** Stored gzipped so 33.4 KB is the wire cost whatever fronts the bucket (ADR 0018). */
export const INDEX_CONTENT_ENCODING = "gzip";

export const INDEX_CONTENT_TYPE = "application/json";

/** The key an index with these bytes lives at. Content-addressed, so a new index is a new key. */
export function indexObjectKey(bytesDigest: string): string {
  return `${INDEX_PREFIX}${bytesDigest}.json`;
}

/* ------------------------------------------------------------------ *
 * The wire shape. Everything below the encodings is spelled out.
 * ------------------------------------------------------------------ */

type WireSpecies = "D" | "C";
type WireSex = "M" | "F" | "U";
type WireSize = "S" | "M" | "L" | "G";
/** `1` yes, `-1` no, `0` not assessed — one character for the value that is not a claim. */
type WireFlag = -1 | 0 | 1;

interface WireAnimal {
  readonly i: string;
  readonly n: string;
  readonly s: WireSpecies;
  readonly r: string;
  /** Omitted for a cat, whose size is not a gap but a shape. */
  readonly z?: WireSize;
  /** `YYYY-MM-DD`: the birth date is an estimate of a day, so a day is what is stored. */
  readonly b: string;
  readonly x: WireSex;
  readonly c: WireFlag;
  readonly d: WireFlag;
  readonly t: WireFlag;
  readonly k: string;
  /**
   * Epoch milliseconds, unlike `b`. A confirmation is an instant (`timestamp_ms` in `db/`)
   * and the ordering is over it, so truncating it to a day would tie every animal a shelter
   * confirmed in one sitting and leave the grid's order to chance.
   */
  readonly f: number;
  /** Omitted for a lone animal. */
  readonly g?: string;
  /** Omitted unless the mark is carried; `1` when it is. */
  readonly u?: 1;
  readonly h: string;
}

interface WireIndex {
  readonly v: 1;
  readonly g: string;
  readonly a: readonly WireAnimal[];
}

/**
 * Encoding tables, written in both directions from one source each.
 *
 * Inverted programmatically rather than typed twice: a decode table that disagreed with its
 * encode table would round-trip an animal into a different animal, and it would do it
 * silently for whichever value nobody wrote a case for.
 */
function invert<Key extends string, Token extends string | number>(
  table: Readonly<Record<Key, Token>>,
): ReadonlyMap<Token, Key> {
  return new Map(
    (Object.keys(table) as Key[]).map((key) => [table[key], key] as const),
  );
}

const SPECIES_TOKENS: Readonly<Record<Species, WireSpecies>> = {
  dog: "D",
  cat: "C",
};

const SEX_TOKENS: Readonly<Record<Sex, WireSex>> = {
  Male: "M",
  Female: "F",
  Unknown: "U",
};

const SIZE_TOKENS: Readonly<Record<Size, WireSize>> = {
  Small: "S",
  Medium: "M",
  Large: "L",
  Giant: "G",
};

const FLAG_TOKENS: Readonly<Record<GoodWithFlag, WireFlag>> = {
  Yes: 1,
  No: -1,
  Unknown: 0,
};

const SPECIES_BY_TOKEN = invert(SPECIES_TOKENS);
const SEX_BY_TOKEN = invert(SEX_TOKENS);
const SIZE_BY_TOKEN = invert(SIZE_TOKENS);
const FLAG_BY_TOKEN = invert(FLAG_TOKENS);

/**
 * Decoding throws on a token the tables do not know, rather than substituting a default.
 *
 * The direction is chosen deliberately. A default would show an adopter an animal described
 * as something nobody said it was, and would show it forever; refusing to parse the file
 * fails the listing loudly, in the one situation where the file cannot have come from this
 * codebase.
 */
function decode<Token extends string | number, Value>(
  table: ReadonlyMap<Token, Value>,
  token: Token,
  field: string,
): Value {
  const value = table.get(token);
  if (value === undefined) {
    throw new Error(`filter index: unknown ${field} ${JSON.stringify(token)}`);
  }
  return value;
}

/** The one place the three good-with columns become the axis-keyed record. */
function wireFlags(goodWith: GoodWithFlags): Pick<WireAnimal, "c" | "d" | "t"> {
  return {
    c: FLAG_TOKENS[goodWith.children],
    d: FLAG_TOKENS[goodWith.dogs],
    t: FLAG_TOKENS[goodWith.cats],
  };
}

function readFlags(wire: WireAnimal): GoodWithFlags {
  const tokens: Readonly<Record<GoodWithAxis, WireFlag>> = {
    children: wire.c,
    dogs: wire.d,
    cats: wire.t,
  };
  const flags = {} as Record<GoodWithAxis, GoodWithFlag>;
  for (const axis of GOOD_WITH_AXES) {
    flags[axis] = decode(FLAG_BY_TOKEN, tokens[axis], `good-with ${axis}`);
  }
  return flags;
}

/** `YYYY-MM-DD` in UTC, which is the only zone this platform stores a date in. */
function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A `YYYY-MM-DD` back to the instant of its UTC midnight.
 *
 * `Date.parse` on a bare date string is specified as UTC, and going through it rather than
 * splitting the string by hand is what keeps this the exact inverse of {@link toDayString}.
 */
function fromDayString(day: string, field: string): Date {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at)) {
    throw new Error(`filter index: unreadable ${field} ${JSON.stringify(day)}`);
  }
  return new Date(at);
}

function toWire(animal: ListedAnimal): WireAnimal {
  return {
    i: animal.id,
    n: animal.name,
    s: SPECIES_TOKENS[animal.species],
    r: animal.region,
    ...(animal.size === null ? {} : { z: SIZE_TOKENS[animal.size] }),
    b: toDayString(animal.estimatedBirthDate),
    x: SEX_TOKENS[animal.sex],
    ...wireFlags(animal.goodWith),
    k: animal.thumbnailKey,
    f: animal.lastConfirmedAt.getTime(),
    ...(animal.bondedGroupId === null ? {} : { g: animal.bondedGroupId }),
    ...(animal.urgent ? { u: 1 as const } : {}),
    h: animal.shelterId,
  };
}

function fromWire(wire: WireAnimal): ListedAnimal {
  return {
    id: wire.i,
    name: wire.n,
    species: decode(SPECIES_BY_TOKEN, wire.s, "species"),
    region: wire.r,
    size: wire.z === undefined ? null : decode(SIZE_BY_TOKEN, wire.z, "size"),
    sex: decode(SEX_BY_TOKEN, wire.x, "sex"),
    estimatedBirthDate: fromDayString(wire.b, "birth date"),
    lastConfirmedAt: new Date(wire.f),
    goodWith: readFlags(wire),
    thumbnailKey: wire.k,
    bondedGroupId: wire.g ?? null,
    urgent: wire.u === 1,
    shelterId: wire.h,
  };
}

/**
 * The index as bytes: sorted by id, then serialized.
 *
 * **The sort is here as well as in the regenerator's SQL, and neither is redundant.**
 * ADR 0018 puts an explicit `ORDER BY` on the animal id in the read because
 * content-addressing is only idempotent if identical data serializes to identical bytes.
 * That line of SQL is the one the ADR argues for; this is the same invariant held by the
 * function that produces the bytes, so a caller assembling the list from anywhere else — a
 * paged read stitched together, a test, a later consumer — cannot mint a new key for an
 * unchanged catalogue by handing them over in a different order.
 *
 * `JSON.stringify` over an array of objects built by {@link toWire} emits keys in insertion
 * order, and that order is fixed by one object literal, so the bytes are a function of the
 * animals alone.
 */
export function serializeIndex(index: FilterIndex): string {
  const animals = [...index.animals]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(toWire);
  const wire: WireIndex = { v: 1, g: index.generatedAt, a: animals };
  return JSON.stringify(wire);
}

/** What {@link serializeIndex} wrote, back again. */
export function parseIndex(text: string): FilterIndex {
  const wire = JSON.parse(text) as WireIndex;
  if (wire.v !== 1) {
    throw new Error(`filter index: unsupported version ${String(wire.v)}`);
  }
  return { generatedAt: wire.g, animals: wire.a.map(fromWire) };
}

/**
 * The day an index's `generatedAt` records, from the instant the read was taken.
 *
 * Rounded, and {@link FilterIndex} says why: an instant here would mint a new key on every
 * nightly run over an unchanged catalogue, turning ADR 0018's free no-op into a write plus
 * an orphan every night.
 */
export function indexGeneratedAt(readAt: Date): string {
  return toDayString(readAt);
}

/* ------------------------------------------------------------------ *
 * The ordering, and the filter.
 * ------------------------------------------------------------------ */

/**
 * Freshest-confirmed first, and the direction is the decision.
 *
 * ADR 0001 gives staleness the ordering and nothing else: an animal nobody has confirmed in
 * four months sinks, and that is what makes the monthly nudge worth answering. Urgency is
 * **not** a sort key — the cap is three per shelter and the listing is cross-shelter, so
 * urgency-first ordering would let a handful of shelters own the first screen (#17).
 *
 * **This comparator is one character from the one that inverts it**, and the inverted one
 * leads the listing with the stalest animals — which the prototype's first draft actually
 * did. `filter-index.test.ts` pins the direction with real dates rather than asserting the
 * sign of one call, because a sign is exactly what a mistyped subtraction still returns.
 *
 * The tie-break on id is what makes it a total order. Confirmations arrive a shelterful at a
 * time, so same-instant ties are the common case rather than a curiosity, and without a
 * tie-break the grid's order among them would be whatever the sort happened to do.
 */
export function compareByFreshestConfirmed(
  left: ListedAnimal,
  right: ListedAnimal,
): number {
  const byFreshness = right.lastConfirmedAt.getTime() - left.lastConfirmedAt.getTime();
  if (byFreshness !== 0) return byFreshness;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * The animals an adopter's filters leave, in the order the listing shows them.
 *
 * The filtering is `matches` — the digest matcher's own function, called on the index entry
 * directly, because {@link ListedAnimal} is a structural superset of `AnimalAxes`. Issue #56
 * requires that the island import `domain/` rather than reimplement any rule, and this is
 * the function it imports: the six axes, the several-regions-at-once rule ADR 0005 asked
 * for, and the good-with rule that excludes only an explicit `No` are all already stated
 * once, in `matching.ts`.
 *
 * `now` is an argument for `matching.ts`'s reason: the age-band axis is derived from a date,
 * and a rule that reads the clock itself is a rule no test can pin.
 */
export function selectListed(
  animals: readonly ListedAnimal[],
  criteria: SubscriptionCriteria,
  now: Date,
): readonly ListedAnimal[] {
  return animals
    .filter((animal) => matches(criteria, axesOf(animal), now))
    .sort(compareByFreshestConfirmed);
}

/**
 * One index entry as the axes the matcher compares, which is the entry itself with **its
 * region normalised**.
 *
 * That one substitution is load-bearing and it is easy to miss. The index carries a region as
 * its shelter typed it, because the same string is what a card displays — `Miranda`, not
 * `miranda`. A criteria carries it as an identifier, because `criteria.ts` trims and
 * lower-cases every submitted region so that `Aragua`, `aragua` and ` aragua ` are one
 * region. `matches` compares the two by membership, so without this the region axis would
 * exclude every animal on the platform while every other axis worked — the quietest possible
 * failure, and one no test of `matches` alone can see.
 *
 * `criteria.ts` has said all along that "the same normalisation has to happen on the animal's
 * side for the two to ever meet". This is the animal's side, and it meets it through that
 * module's own exported function rather than through a second `toLowerCase()`.
 */
function axesOf(animal: ListedAnimal): AnimalAxes {
  return {
    ...(animal satisfies AnimalAxes),
    region: normaliseRegion(animal.region),
  };
}

/* ------------------------------------------------------------------ *
 * Keeping the prefix.
 * ------------------------------------------------------------------ */

/**
 * The grace an aged-out index gets before it is collected: one hour.
 *
 * It covers a reader that holds the pointer and has not yet fetched the index it names —
 * the two fetches of one page load, seconds at worst on a bad connection. An hour is three
 * orders of magnitude of headroom, chosen to be obviously enough rather than tuned
 * (ADR 0018).
 */
export const SUPERSEDED_INDEX_GRACE_MS = 3_600_000;

/** One object as R2 lists it. `uploaded` comes back on every listed object, so no join. */
export interface StoredIndexObject {
  readonly key: string;
  readonly uploaded: Date;
}

/**
 * Whether an object under `i/` may be deleted, and **all three conditions are load-bearing**.
 *
 * It must not be the pointer, which lives in this same prefix — a rule phrased only as "what
 * the pointer does not name" would delete the pointer itself on the first run. It must not be
 * the index the pointer currently names. And it must have aged past the grace above, for the
 * reader that is between its two fetches.
 *
 * A pure rule rather than a filter written inline in the regenerator, because it is the one
 * piece of prefix-keeping that can delete a live object, and the three conditions deserve a
 * test each without an R2 bucket in the way.
 */
export function isSupersededIndexObject(
  object: StoredIndexObject,
  live: { readonly pointerKey: string; readonly now: Date },
): boolean {
  if (object.key === INDEX_POINTER_KEY) return false;
  if (object.key === live.pointerKey) return false;
  return (
    live.now.getTime() - object.uploaded.getTime() > SUPERSEDED_INDEX_GRACE_MS
  );
}
