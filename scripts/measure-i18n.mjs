#!/usr/bin/env node
/**
 * Every number in ADR 0018, with one command.
 *
 *   npm run check:i18n                     repo-derived numbers only
 *   node scripts/measure-i18n.mjs --icu    also bundles intl-messageformat (needs network)
 *
 * The repo-derived figures come from the issue #17 prototype's own copy table, which is
 * the only real string table Pawster has. The `--icu` run installs `intl-messageformat`
 * and `esbuild` into a temp directory, bundles one gender-select message, and throws the
 * directory away; it is separate because it is the only part that needs a network.
 *
 * ADR 0007's measurements have `scripts/measure-bundle-size.mjs` and
 * `scripts/measure-ssr-cpu.mjs` for the same reason: a number in an ADR that no command
 * reproduces is a number nobody can check when it drifts. Like `measure-bundle-size.mjs`,
 * this script exits non-zero when the invariant it checks is broken, so it can be run in
 * CI rather than only read.
 */

import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOTYPE = join(ROOT, "prototypes/public-listing/index.html");

/**
 * Pinned, because ADR 0018 quotes this package's bundled size to the byte. Unpinned, the
 * three ICU figures in the ADR would silently drift on the next run - the exact failure
 * the ADR's "every number has one command" consequence exists to prevent.
 */
const ICU_VERSION = "11.2.14";

/* ------------------------------------------------------------------ *
 * Pull the COPY object out of the prototype and evaluate it, rather than
 * matching it with a regex. A regex over the source counts a string that
 * sits inside a template literal twice, and counts strings that appear in
 * comments at all - which is how a first pass produced an es/en asymmetry
 * that cannot exist, since the two locales have the same key structure.
 * ------------------------------------------------------------------ */

function extractCopy() {
  const src = readFileSync(PROTOTYPE, "utf8");
  const start = src.indexOf("const COPY = {");
  if (start < 0) throw new Error("COPY not found in " + PROTOTYPE);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const G = (pair, sex) => (sex === "Female" ? pair[1] : pair[0]);
  return new Function("G", "return " + src.slice(open, i + 1))(G);
}

/** A gendered pair is `[masculine, feminine]`: one key, two words somebody had to choose. */
const isGenderedPair = (node) =>
  Array.isArray(node) && node.length === 2 && node.every((s) => typeof s === "string");

/**
 * The one traversal. Every figure below is derived from it, so what counts as a leaf is
 * defined in a single place. An earlier version had three walks carrying three slightly
 * different leaf predicates, and two of them disagreed with each other about whether a
 * gendered pair is one leaf or two.
 *
 * `visit` is called once per leaf with `{ kind, value, path }`, where `kind` is one of:
 *   pair      a gendered pair - one key in the structure, two translatable words
 *   string    a plain string
 *   function  a phrase-building function
 */
function walkLeaves(node, visit, path = "") {
  if (isGenderedPair(node)) return visit({ kind: "pair", value: node, path });
  if (typeof node === "string") return visit({ kind: "string", value: node, path });
  if (typeof node === "function") return visit({ kind: "function", value: node, path });
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      walkLeaves(v, visit, path ? path + "." + k : k);
    }
  }
}

/** Everything one locale contributes, from a single pass. */
function summarise(locale) {
  let strings = 0;
  let functions = 0;
  const pairs = [];
  const paths = [];
  walkLeaves(locale, ({ kind, value, path }) => {
    paths.push(path);
    if (kind === "pair") {
      strings += 2;
      pairs.push(value);
    } else if (kind === "string") {
      strings += 1;
    } else {
      functions += 1;
    }
  });
  return { strings, functions, pairs, paths };
}

/**
 * Serialise one locale back to source so gzip measures the payload a bundle would carry,
 * not the prototype's indentation. Functions are emitted as their source text. This is a
 * renderer rather than a fourth traversal: it reproduces the structure it walks, so it
 * cannot share `walkLeaves`, which discards it.
 */
function serialise(node) {
  if (typeof node === "function") return node.toString();
  if (typeof node === "string") return JSON.stringify(node);
  if (Array.isArray(node)) return "[" + node.map(serialise).join(",") + "]";
  return "{" + Object.entries(node).map(([k, v]) => JSON.stringify(k) + ":" + serialise(v)).join(",") + "}";
}

const gz = (s) => gzipSync(Buffer.from(s), { level: 9 }).length;

/* ------------------------------------------------------------------ */

const copy = extractCopy();
const locales = Object.keys(copy);
const summaries = Object.fromEntries(locales.map((l) => [l, summarise(copy[l])]));

console.log("Source: prototypes/public-listing/index.html (issue #17)\n");

console.log("Leaf phrases per locale");
console.log("  a leaf phrase = one string or one phrase-building function;");
console.log("  a gendered pair contributes two, one per form.\n");
for (const loc of locales) {
  const { strings, functions } = summaries[loc];
  console.log(
    "  " + loc.padEnd(4),
    String(strings + functions).padStart(4),
    `(strings ${strings}, functions ${functions})`,
  );
}

/**
 * The locales must have identical key structures - a drift here means one locale has a
 * phrase the other does not, which is the asymmetry ADR 0018 says cannot exist. Treated
 * as a failure, not a note, so the claim stays true rather than merely printed.
 */
const shapes = locales.map((l) => summaries[l].paths.slice().sort().join("\n"));
const drifted = shapes.some((s) => s !== shapes[0]);
console.log("\n  key structures identical across locales:", drifted ? "NO" : "yes");

console.log("\nGendered pairs");
for (const loc of locales) {
  const distinct = [...new Set(summaries[loc].pairs.map((p) => JSON.stringify(p)))].map((s) =>
    JSON.parse(s),
  );
  const identical = distinct.filter(([m, f]) => m === f);
  console.log(
    "  " + loc.padEnd(4),
    String(distinct.length).padStart(3),
    "distinct,",
    String(identical.length).padStart(3),
    "with m === f",
    "->",
    distinct.filter(([m, f]) => m !== f).map(([m, f]) => `${m}/${f}`).join(", "),
  );
}

console.log("\nPayload, gzip level 9");
const parts = {};
for (const loc of locales) parts[loc] = serialise(copy[loc]);
for (const loc of locales) {
  console.log(
    "  " + (loc + " only").padEnd(14),
    String(Buffer.byteLength(parts[loc])).padStart(6),
    "B raw",
    String(gz(parts[loc])).padStart(6),
    "B gzip",
  );
}
const both = Object.values(parts).join("");
const one = gz(parts[locales[0]]);
console.log(
  "  " + "all locales".padEnd(14),
  String(Buffer.byteLength(both)).padStart(6),
  "B raw",
  String(gz(both)).padStart(6),
  "B gzip",
);
console.log("  delta of shipping every locale over one:", gz(both) - one, "B");

/* ------------------------------------------------------------------ */

if (process.argv.includes("--icu")) {
  console.log("\nICU MessageFormat runtime (the rejected alternative)");
  const dir = mkdtempSync(join(tmpdir(), "pawster-icu-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "icu-probe", private: true, type: "module" }));
    execFileSync("npm", ["i", "--no-audit", "--no-fund", "--silent", `intl-messageformat@${ICU_VERSION}`, "esbuild"], {
      cwd: dir,
      stdio: "ignore",
    });
    writeFileSync(
      join(dir, "entry.mjs"),
      [
        'import { IntlMessageFormat } from "intl-messageformat";',
        "// The smallest thing that exercises gender agreement through ICU `select`, which is",
        "// the only reason the runtime would be in the bundle at all.",
        'const msg = new IntlMessageFormat("{sex, select, female {Perra} other {Perro}} {band}", "es-VE");',
        "globalThis.render = (sex, band) => msg.format({ sex, band });",
        "",
      ].join("\n"),
    );
    execFileSync(join(dir, "node_modules/.bin/esbuild"), [
      join(dir, "entry.mjs"),
      "--bundle",
      "--minify",
      "--format=esm",
      "--platform=browser",
      "--outfile=" + join(dir, "out.js"),
    ], { stdio: "ignore" });
    const out = readFileSync(join(dir, "out.js"));
    const version = JSON.parse(
      readFileSync(join(dir, "node_modules/intl-messageformat/package.json"), "utf8"),
    ).version;
    console.log("  intl-messageformat", version, "+ one gender-select message");
    console.log("   ", out.length, "B minified,", gz(out), "B gzip");
    console.log("    ratio to all locales as plain modules:", (gz(out) / gz(both)).toFixed(2) + "x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log("\n(re-run with --icu to measure the rejected ICU runtime; needs a network)");
}

if (drifted) {
  console.error("\nFAIL: the locales have drifted - one has a phrase the other does not.");
  process.exit(1);
}
