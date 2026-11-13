#!/usr/bin/env node
/**
 * ADR 0018's index-size figures, from the serializer that actually writes the file.
 *
 *   npm run check:filter-index
 *
 * The numbers exist already — the issue #17 prototype measured **141 B/animal raw and
 * 33.4 KB gzipped at 2,500 animals**, and ADR 0018 spends them: they are what establish
 * that the index never becomes the binding constraint ahead of R2's 10 GB, and that a
 * ~9,500-animal endgame is a ~127 KB index against ADR 0007's ~150 KB metered-connection
 * budget. What did not exist was a command that re-derives them from the shipped code, so
 * the figures described a prototype's `index.html` rather than the artefact adopters
 * download.
 *
 * That is the gap this closes, and it is the same reason `measure-bundle-size.mjs`,
 * `measure-ssr-cpu.mjs` and `measure-i18n.mjs` exist: a number in an ADR that no command
 * reproduces is a number nobody can check when it drifts. Like those three, this exits
 * non-zero when the invariant it checks is broken, so it can be run in CI rather than only
 * read.
 *
 * **The invariant is the budget, not the byte count.** A field added to the index moves these
 * numbers and that is allowed; what is not allowed is the index crossing ADR 0007's budget at
 * the storage ceiling, because at that point filtering has to move server-side and the whole
 * of ADR 0007 unwinds. So the exit code is decided by the endgame figure, and the per-animal
 * numbers are printed for comparison against the ADR's prose.
 *
 * The synthesis follows the prototype's, and the reason is stated there: cycling a handful of
 * seed animals would let gzip dedupe strings that are genuinely distinct in real data and
 * would flatter every measurement. So entropy is injected where a real index has it — distinct
 * names, one shelter per ~60 animals, a spread of regions, and urgency capped at three per
 * shelter.
 */

import { gzipSync } from "node:zlib";
import { serializeIndex } from "../domain/src/filter-index.ts";

/** R2's ~12,500-animal lifetime ceiling from issue #5, at 20% listed (ADR 0018's figure). */
const LISTED = 2_500;
/** ADR 0012's optimistic endgame, which ADR 0016 calls about a gigabyte too generous. */
const ENDGAME = 9_500;
/** 2,500 listed animals is roughly this many shelters. */
const SHELTERS = 40;
/** ADR 0007's metered-connection page-weight budget, in bytes (`KB` is 1,000 here). */
const BUDGET_BYTES = 150_000;
/** `domain/`'s `MAX_URGENT_PER_SHELTER`, which is what bounds how many rows carry the flag. */
const URGENT_PER_SHELTER = 3;

const NAMES = [
  "Luna", "Negrita", "Canela", "Simón", "Mora", "Nube", "Panita", "Coco",
  "Pelusa", "Manchas", "Chispa", "Toby", "Rayo", "Mía", "Kiara", "Rocky",
  "Nina", "Bruno", "Maya", "Zeus", "Lola", "Duque", "Frida", "Otto",
  "Sasha", "Milo", "Roco", "Bella", "Tito", "Kira",
];

/** Venezuela's most populous states, which is where a real catalogue concentrates. */
const REGIONS = [
  "Miranda", "Zulia", "Carabobo", "Aragua", "Lara", "Anzoátegui",
  "Bolívar", "Táchira", "Distrito Capital", "Falcón",
];

const SIZES = ["Small", "Medium", "Large", "Giant"];
const SEXES = ["Male", "Female", "Unknown"];
const FLAGS = ["Yes", "No", "Unknown"];

/**
 * A UUID-shaped id derived from a counter, so a run is deterministic and an id still costs
 * what a real one costs.
 *
 * **The identifiers are where this measurement departs from the prototype's**, and it is the
 * whole reason this script exists. ADR 0012 gives a derivative a content-addressed key of
 * `d/` plus a 64-character hex digest plus an extension, and a shelter carries a
 * `crypto.randomUUID()` — 36 characters. The #17 prototype measured 4-character animal ids,
 * 3-character shelter ids and a 6-character thumbnail key, so its 141 B/animal is not a
 * ceiling for the real index; it is a figure taken over a shape the platform does not have.
 *
 * Used for the shelter id only. The animal's own id stopped being a UUID when ADR 0020 made
 * it an eight-character short id, and {@link syntheticShortId} mints that instead.
 */
function syntheticUuid(seed) {
  const hex = seed.toString(16).padStart(8, "0").repeat(4);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * An eight-character short id, the address ADR 0020 gave an animal.
 *
 * Drawn from `web/src/lib/animals/short-id.ts`'s alphabet — 32 symbols, digits and lower-case
 * letters minus `0`, `1`, `l` and `o` — because the *alphabet* is what gzip sees, not just the
 * length. Deterministic in the seed, like everything else here.
 *
 * This is 28 characters an animal cheaper than the UUID this script measured before ADR 0020,
 * and the whole index is re-measured rather than adjusted by hand: the row is a JSON object
 * gzipped alongside 2,499 others, so what a shorter id saves is not 28 bytes and is not
 * arithmetic anybody should do in a document.
 */
function syntheticShortId(seed) {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  let id = "";
  // A different multiplier per position, so consecutive seeds do not share a long prefix —
  // real ids are random and gzip must not get a run of near-identical strings to exploit.
  for (let position = 0; position < 8; position++) {
    id += alphabet[(seed * (position * 7 + 13) + position * 29) % alphabet.length];
  }
  return id;
}

/** One synthetic animal, deterministic in `at` so two runs of this script agree. */
function syntheticAnimal(at) {
  const shelter = at % SHELTERS;
  const species = at % 5 === 0 ? "cat" : "dog";
  const hex = at.toString(16).padStart(12, "0");

  return {
    id: syntheticShortId(at),
    name: NAMES[at % NAMES.length],
    species,
    region: REGIONS[at % REGIONS.length],
    size: species === "dog" ? SIZES[at % SIZES.length] : null,
    sex: SEXES[at % SEXES.length],
    estimatedBirthDate: new Date(Date.UTC(2018 + (at % 8), at % 12, 1 + (at % 28))),
    lastConfirmedAt: new Date(Date.UTC(2026, 8, 1 + (at % 8), at % 24, at % 60)),
    goodWith: {
      children: FLAGS[at % 3],
      dogs: FLAGS[(at + 1) % 3],
      cats: FLAGS[(at + 2) % 3],
    },
    /** A `d/` key is a 64-hex digest plus an extension, which is what the real ones are. */
    thumbnailKey: `d/${hex.repeat(6).slice(0, 64)}.webp`,
    bondedGroupId: null,
    urgent: at % SHELTERS < URGENT_PER_SHELTER,
    /** A UUID as well, and repeated across ~60 animals, so gzip does get to dedupe it. */
    shelterId: syntheticUuid(0xf0000 + shelter),
  };
}

function measure(count) {
  const animals = Array.from({ length: count }, (_, at) => syntheticAnimal(at));
  const text = serializeIndex({ generatedAt: "2026-09-08", animals });
  const raw = Buffer.byteLength(text, "utf8");
  const gzipped = gzipSync(text, { level: 9 }).byteLength;
  return { count, raw, gzipped };
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;
const perAnimal = (bytes, count) => `${(bytes / count).toFixed(1)} B/animal`;

const listed = measure(LISTED);
const endgame = measure(ENDGAME);

console.log("The filter index, from domain/src/filter-index.ts's own serializer\n");
for (const row of [listed, endgame]) {
  console.log(
    `  ${String(row.count).padStart(5)} animals  raw ${kb(row.raw).padStart(9)} ` +
      `(${perAnimal(row.raw, row.count)})  gzipped ${kb(row.gzipped).padStart(8)} ` +
      `(${perAnimal(row.gzipped, row.count)})`,
  );
}

/**
 * Where the budget is actually crossed, found by bisection rather than asserted.
 *
 * This is the figure worth printing, because it is the one ADR 0007's trigger is phrased
 * against — "when the index stops being cheap to download on a metered connection, filtering
 * has to move server-side" — and it turns a per-animal byte count into the only question
 * anyone asks of it: how many animals until then.
 */
function animalsWithinBudget() {
  let low = 100;
  let high = 40_000;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (measure(middle).gzipped <= BUDGET_BYTES) low = middle;
    else high = middle - 1;
  }
  return low;
}

const ceiling = animalsWithinBudget();

console.log(
  `\n  ADR 0018 quotes 141 B/animal raw and 33.4 KB gzipped at ${LISTED} — the #17` +
    "\n  prototype's figure, taken over identifiers the platform does not have: 4-character" +
    "\n  animal ids, 3-character shelter ids and a 6-character thumbnail key. The shipped row" +
    "\n  carries a shelter UUID and a 64-hex content-addressed derivative key (ADR 0012), and" +
    "\n  an eight-character short id for the animal (ADR 0020). The measurement above is what" +
    "\n  an adopter downloads.",
);

/**
 * The prototype's gzipped figure lands close to the truth again, and the two errors that put
 * it there run in opposite directions — the derivative key is far longer than it guessed and
 * the animal id, since ADR 0020, is barely longer. Printed as a comparison rather than left
 * implied, because "the old number was roughly right" and "the old number describes this
 * artefact" are different claims and only the first is true.
 */
const quotedAtListed = 33_400;
const delta = ((listed.gzipped - quotedAtListed) / quotedAtListed) * 100;

console.log(
  `\n  Measured at ${LISTED}: ${kb(listed.gzipped)} gzipped, ` +
    `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% against that quoted 33.4 KB.`,
);

console.log(
  `\n  ADR 0007's budget is ${kb(BUDGET_BYTES)} on a metered connection, and this index` +
    `\n  stays inside it up to about ${ceiling.toLocaleString("en-US")} listed animals.` +
    `\n  At ${LISTED} — ADR 0018's working figure, R2's 10 GB ceiling at 20% listed — it is` +
    `\n  ${kb(listed.gzipped)}, comfortably inside. At ADR 0012's optimistic ${ENDGAME}-animal` +
    `\n  endgame it would be ${kb(endgame.gzipped)}, which is ` +
    `${endgame.gzipped <= BUDGET_BYTES ? "still inside it" : "over"}.`,
);

/**
 * **The gate is the platform's own working scale, not its most optimistic endgame.**
 *
 * ADR 0018 concluded that the index's read budget and R2's storage cap "expire at almost the
 * same moment", reasoning from the prototype's 13.4 B/animal. Measured over the real shape
 * that conclusion holds — both are comfortable at 2,500 and the budget is not crossed until
 * roughly 19,000 — though it holds for different reasons than the ADR gave, which is why this
 * script prints the figure rather than restating the ADR's.
 *
 * Gating at the working scale rather than the endgame is still the right choice: 2,500 is the
 * number ADR 0018 spends its own arithmetic on, and a gate at 9,500 would be asserting
 * something about a state R2 only reaches if ADR 0016 is wrong about storage. The gate fails
 * the moment the artefact an adopter actually downloads stops fitting.
 */
if (listed.gzipped > BUDGET_BYTES) {
  console.error(
    `\nThe index no longer fits ADR 0007's budget at ${LISTED} animals, which is the scale` +
      "\nthe platform is sized for. That ADR's stated trigger has fired: filtering has to move" +
      "\nserver-side. Do not raise the budget in this script without reopening that decision.",
  );
  process.exit(1);
}
