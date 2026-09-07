#!/usr/bin/env node
/**
 * Two structural rules that no test can enforce, checked over the source instead.
 *
 * Both exist because the thing they forbid *passes* at runtime. A module-scope Drizzle
 * client runs fine locally and breaks in production; a `db/` import inside `domain/` is
 * just an import. Neither has a failing test to point at, so this is the enforcement.
 *
 *   node scripts/check-source-rules.mjs
 *
 * Run by `npm test` at the root.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Deliberately-wrong code, kept as a demonstration. Exempt by design. */
const EXEMPT = ["db/test/fixture/"];

/**
 * Source *and* tests. The tests are scanned because `db/test/fixture/` is the one place
 * allowed to hold a module-scope client, and an exemption over a directory nobody scans
 * exempts nothing — it just reads as though the rule were enforced there.
 */
const SOURCE_DIRS = [
  "domain/src",
  "db/src",
  "db/test",
  "digest/src",
  "digest/test",
  "web/src",
  "web/test",
  "test",
];

function walk(dir) {
  let files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files = files.concat(walk(path));
    else if (/\.(ts|mts|astro)$/.test(path)) files.push(path);
  }
  return files;
}

const failures = [];

function fail(file, line, rule, detail) {
  failures.push({ file: relative(ROOT, file), line, rule, detail });
}

const files = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir))).filter(
  (file) => !EXEMPT.some((prefix) => relative(ROOT, file).startsWith(prefix)),
);

for (const file of files) {
  const relPath = relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  const inDomain = relPath.startsWith("domain/");

  /**
   * Every name declared at column 0 — the file's module scope. A client assigned to one of
   * these outlives the request that built it, however deep inside a function the
   * assignment is written.
   */
  const moduleScopeNames = new Set(
    lines
      .map((line) => line.match(/^(?:export\s+)?(?:const|let|var)\s+([\w$]+)/))
      .filter((match) => match !== null)
      .map((match) => match[1]),
  );

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    /**
     * Rule 1: no Drizzle client at module scope (ADR 0007).
     *
     * Two shapes, because the fixture demonstrates two and calls the second the more
     * common one:
     *
     *   const db = createDb(env.DB);            // built during module evaluation
     *   let cached; cached ??= drizzle(env.DB); // built in one request and kept
     *
     * The first is a column-0 declaration, which is a sound heuristic here: everything in
     * this repo is Prettier-formatted, so a binding inside a function body is indented.
     * The second is an assignment *to a module-scope name*, at any indentation — that is
     * what `moduleScopeNames` below is collected for. Only bare assignments count, never
     * declarations, so a `const db = createDb(...)` inside a handler that happens to shadow
     * a module-scope name is not flagged.
     *
     * `.astro` files are exempt, and not as a concession: a page's frontmatter *is* the
     * request handler, run once per request for any route that has opted out of
     * prerendering, so a column-0 `const` there is per-request by construction. An Astro
     * page has no module scope to get this wrong in.
     */
    const buildsClient = /(?:createDb|drizzle)\s*\(/.test(line);
    const declaresAtModuleScope =
      /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:await\s+)?(?:createDb|drizzle)\s*\(/.test(
        line,
      );
    const assignsToModuleScopeName = (() => {
      const match = line.match(
        /^\s*([\w$]+)\s*(?:\?\?=|\|\|=|=)\s*(?:await\s+)?(?:createDb|drizzle)\s*\(/,
      );
      if (!match) return false;
      if (/^\s*(?:export\s+)?(?:const|let|var)\s/.test(line)) return false;
      return moduleScopeNames.has(match[1]);
    })();

    if (
      !relPath.endsWith(".astro") &&
      buildsClient &&
      (declaresAtModuleScope || assignsToModuleScopeName)
    ) {
      fail(
        file,
        lineNumber,
        "module-scope Drizzle client",
        "Construct the client inside the request handler, every time, and keep no " +
          "reference to it. ADR 0007; see db/src/index.ts for why, and " +
          "db/test/module-scope-is-wrong.test.ts for what the runtime does about it " +
          "(which is: nothing).",
      );
    }

    if (!inDomain) return;

    // Rule 2: `domain/` is pure — no I/O, and no `db/`.
    const importMatch = line.match(
      /^\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/,
    );
    const specifier = importMatch?.[1];
    if (specifier) {
      const isRelative = specifier.startsWith(".");
      const escapesPackage = specifier.startsWith("../../");
      if (specifier.startsWith("node:")) {
        fail(file, lineNumber, "domain/ imports a Node builtin", specifier);
      } else if (specifier.startsWith("@pawster/db") || specifier === "drizzle-orm") {
        fail(file, lineNumber, "domain/ imports the database layer", specifier);
      } else if (!isRelative && !/\.test\.ts$/.test(relPath)) {
        fail(
          file,
          lineNumber,
          "domain/ imports a package",
          `${specifier} — domain/ depends on nothing, which is what makes it free to test`,
        );
      } else if (escapesPackage) {
        fail(file, lineNumber, "domain/ reaches outside itself", specifier);
      }
    }

    if (!/\.test\.ts$/.test(relPath) && /\bfetch\s*\(/.test(line)) {
      fail(file, lineNumber, "domain/ performs I/O", line.trim());
    }
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} source-rule violation(s):\n`);
  for (const { file, line, rule, detail } of failures) {
    console.error(`  ${file}:${line}`);
    console.error(`    ${rule}`);
    console.error(`    ${detail}\n`);
  }
  process.exit(1);
}

console.log(
  `source rules ok — ${files.length} files checked for module-scope Drizzle clients and domain/ purity`,
);
