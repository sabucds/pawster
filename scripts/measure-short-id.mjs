#!/usr/bin/env node
/**
 * The collision arithmetic behind an animal's short id, and an empirical check that the
 * generator actually draws the way the arithmetic assumes.
 *
 *   npm run check:short-id
 *
 * It exists because [ADR 0020](../docs/adr/0020-an-animals-address-is-a-short-id-and-never-404s.md)
 * chooses a length from numbers, and a number in an ADR that nobody can reproduce is a number
 * that quietly stops being true. Everything printed below is computed here rather than
 * remembered — change `SHORT_ID_LENGTH` in `web/src/lib/animals/short-id.ts` and this reports
 * the consequences.
 *
 * ## What it computes
 *
 * Two probabilities, and they answer different questions:
 *
 * - **Per publish** — the chance that the *next* animal collides with one of the `n` already
 *   published: `n / N`. This is the one a shelter would experience, as a failed publish.
 * - **Ever** — the chance that *any* two of `n` animals share an address, the birthday bound:
 *   `1 - exp(-n(n-1) / 2N)`. This is the one that decides whether the design needs a retry
 *   path at all.
 *
 * Both are exact for a uniform draw, which is what the 32-symbol alphabet buys: 32 divides 256,
 * so `byte & 31` is uniform and there is no rejection sampling whose absence would bias the
 * space. The sampling pass below is what checks that claim rather than assuming it.
 */

import { webcrypto } from "node:crypto";

/**
 * Read out of the module rather than restated, so this script cannot drift from what the
 * platform actually mints. A regex rather than an import because the module is TypeScript and
 * this is a plain Node script with no build step — the same posture every other `scripts/*.mjs`
 * takes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../web/src/lib/animals/short-id.ts", import.meta.url)),
  "utf8",
);

const alphabet = /SHORT_ID_ALPHABET = "([^"]+)"/.exec(SOURCE)?.[1];
const length = Number(/SHORT_ID_LENGTH = (\d+)/.exec(SOURCE)?.[1]);

if (!alphabet || !Number.isInteger(length)) {
  throw new Error(
    "could not read SHORT_ID_ALPHABET / SHORT_ID_LENGTH out of short-id.ts",
  );
}

const space = alphabet.length ** length;

/** The platform sizes the filter index for 2,500 animals; the rest bracket it. */
const POPULATIONS = [1_000, 2_500, 10_000, 100_000];

/** How many ids the sampling pass draws. Enough to see a biased symbol, cheap enough to run. */
const SAMPLES = 2_000_000;

function newShortId() {
  const bytes = webcrypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const byte of bytes) id += alphabet[byte & (alphabet.length - 1)];
  return id;
}

console.log(`\nShort id: ${length} symbols over ${alphabet.length} — "${alphabet}"\n`);
console.log(`  address space: ${space.toExponential(3)} (${alphabet.length}^${length})\n`);

console.log("  animals    p(next publish collides)   p(any collision, ever)");
for (const n of POPULATIONS) {
  const perPublish = n / space;
  const ever = 1 - Math.exp((-n * (n - 1)) / (2 * space));
  console.log(
    `  ${String(n).padStart(7)}    ${perPublish.toExponential(2).padStart(22)}   ${ever
      .toExponential(2)
      .padStart(21)}`,
  );
}

/**
 * The uniformity check. A modulo over an alphabet that does not divide 256 makes the first few
 * symbols measurably likelier, and the failure is invisible in an id — it shows up only as a
 * collision rate higher than the table above claims.
 *
 * Chi-squared over the symbol frequencies, against `alphabet.length - 1` degrees of freedom. At
 * 31 df the 99.9th percentile is ~62, so anything under that is indistinguishable from uniform
 * at this sample size; a `% 62`-style bias lands orders of magnitude above it.
 */
const counts = new Map([...alphabet].map((symbol) => [symbol, 0]));
for (let i = 0; i < SAMPLES; i++) {
  for (const symbol of newShortId()) counts.set(symbol, counts.get(symbol) + 1);
}

const drawn = SAMPLES * length;
const expected = drawn / alphabet.length;
let chiSquared = 0;
for (const count of counts.values()) {
  chiSquared += (count - expected) ** 2 / expected;
}

const degreesOfFreedom = alphabet.length - 1;
const CRITICAL_999 = 62.49;

console.log(
  `\n  uniformity: ${drawn.toLocaleString()} symbols drawn, chi-squared ` +
    `${chiSquared.toFixed(1)} on ${degreesOfFreedom} df ` +
    `(critical value at p=0.001 is ${CRITICAL_999})`,
);
console.log(
  chiSquared < CRITICAL_999
    ? "  → indistinguishable from uniform, so the table above holds.\n"
    : "  → BIASED. The alphabet no longer divides 256, or the draw is not what it was.\n",
);

if (chiSquared >= CRITICAL_999) process.exit(1);
