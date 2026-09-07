#!/usr/bin/env node
/**
 * Every number in ADR 0017, with one command.
 *
 *   node scripts/measure-i18n.mjs          repo-derived numbers only
 *   node scripts/measure-i18n.mjs --icu    also bundles intl-messageformat (needs network)
 *
 * The repo-derived figures come from the issue #17 prototype's own copy table, which is
 * the only real string table Pawster has. The `--icu` run installs `intl-messageformat`
 * and `esbuild` into a temp directory, bundles one gender-select message, and throws the
 * directory away; it is separate because it is the only part that needs a network.
 *
 * ADR 0007's measurements have `scripts/measure-bundle-size.mjs` and
 * `scripts/measure-ssr-cpu.mjs` for the same reason: a number in an ADR that no command
 * reproduces is a number nobody can check when it drifts.
 */

import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOTYPE = join(ROOT, "prototypes/public-listing/index.html");

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
  const literal = src.slice(open, i + 1);
  const G = (pair, sex) => (sex === "Female" ? pair[1] : pair[0]);
  return { copy: new Function("G", "return " + literal)(G), literal };
}

/**
 * A leaf phrase is one translatable value: a plain string, or a function that builds one.
 * A gendered pair is an array of two strings and contributes two, because each form is a
 * word somebody had to choose. Keys are structure and are not counted.
 */
function countLeaves(node) {
  if (typeof node === "string") return { strings: 1, functions: 0 };
  if (typeof node === "function") return { strings: 0, functions: 1 };
  if (node && typeof node === "object") {
    let strings = 0;
    let functions = 0;
    for (const v of Object.values(node)) {
      const c = countLeaves(v);
      strings += c.strings;
      functions += c.functions;
    }
    return { strings, functions };
  }
  return { strings: 0, functions: 0 };
}

function keypaths(node, prefix = "", out = []) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) keypaths(v, prefix ? prefix + "." + k : k, out);
  } else {
    out.push(prefix);
  }
  return out;
}

function genderedPairs(node, out = []) {
  if (Array.isArray(node) && node.length === 2 && node.every((s) => typeof s === "string")) {
    out.push(node);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) genderedPairs(v, out);
  }
  return out;
}

/**
 * Serialise one locale back to source so gzip measures the payload a bundle would carry,
 * not the prototype's indentation. Functions are emitted as their source text.
 */
function serialise(node) {
  if (typeof node === "function") return node.toString();
  if (typeof node === "string") return JSON.stringify(node);
  if (Array.isArray(node)) return "[" + node.map(serialise).join(",") + "]";
  return "{" + Object.entries(node).map(([k, v]) => JSON.stringify(k) + ":" + serialise(v)).join(",") + "}";
}

const gz = (s) => gzipSync(Buffer.from(s), { level: 9 }).length;

/* ------------------------------------------------------------------ */

const { copy } = extractCopy();
const locales = Object.keys(copy);

console.log("Source: prototypes/public-listing/index.html (issue #17)\n");

console.log("Leaf phrases per locale");
console.log("  a leaf phrase = one string or one phrase-building function;");
console.log("  a gendered pair contributes two, one per form.\n");
for (const loc of locales) {
  const c = countLeaves(copy[loc]);
  console.log(
    "  " + loc.padEnd(4),
    String(c.strings + c.functions).padStart(4),
    `(strings ${c.strings}, functions ${c.functions})`,
  );
}

const paths = locales.map((l) => keypaths(copy[l]).sort().join("\n"));
const sameShape = paths.every((p) => p === paths[0]);
console.log(
  "\n  key structures identical across locales:",
  sameShape ? "yes" : "NO - the locales have drifted",
);

console.log("\nGendered pairs");
for (const loc of locales) {
  const pairs = genderedPairs(copy[loc]);
  const distinct = [...new Set(pairs.map((p) => JSON.stringify(p)))].map((s) => JSON.parse(s));
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
    execFileSync("npm", ["i", "--no-audit", "--no-fund", "--silent", "intl-messageformat", "esbuild"], {
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
