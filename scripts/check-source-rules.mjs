#!/usr/bin/env node
/**
 * Structural rules that no test can enforce, checked over the source instead.
 *
 * Every one of them exists because the thing it forbids *passes* at runtime. A module-scope
 * Drizzle client runs fine locally and breaks in production; a `db/` import inside `domain/`
 * is just an import; the `env.IMAGES` binding works perfectly and quietly spends five times
 * the Worker's CPU budget. None of them has a failing test to point at, so this is the
 * enforcement.
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
     * Whether this line is prose rather than code.
     *
     * A line-level heuristic and not a parse: everything here is Prettier-formatted, so a
     * block comment's continuation lines begin with `*` and nothing else does. It is used
     * only by the two rules below, which forbid things this repository also has to be able
     * to *write about* — the rules above forbid shapes that never appear in prose.
     */
    const isComment = /^\s*(?:\/\/|\/?\*)/.test(line);

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

    /**
     * Rule 3: the image pipeline is `cf.image`, and the `IMAGES` binding is ruled out
     * (ADR 0012).
     *
     * This is here rather than in a test because the binding *works*. It transforms images
     * correctly, returns the right bytes and passes any test written against its output —
     * while running its encode inside our isolate at 22–56 ms of CPU at the median against
     * a 10 ms ceiling, with single invocations measured at 78 ms, where `cf.image` costs
     * 0–2 ms for identical work (issue #34). The distributions do not overlap at any
     * sample. And nothing catches it: `docs/testing-seams.md` records that neither
     * `@cloudflare/vitest-plugin` nor local `workerd` meters CPU, and that every over-budget
     * invocation returns `outcome: ok`. So a reintroduction would be invisible in local
     * development, invisible in CI, and would surface in production as a Worker Cloudflare
     * terminates for "hitting the limit consistently" — which a steady upload path is
     * precisely.
     *
     * Comment lines are skipped, and they have to be: the decision is *documented* in this
     * repository more often than it could ever be violated, and `web/src/lib/images.ts`'s
     * own module comment names the binding in order to rule it out. A rule that fired on
     * prose would be a rule that made the reasoning unwritable, and the reasoning is the
     * more valuable half. The heuristic is Prettier's formatting, the same assumption rule 1
     * makes about column 0.
     */
    if (!isComment && /\b(?:env|locals\.runtime\.env)\s*\.\s*IMAGES\b|(?<!\w)["']IMAGES["']\s*:/.test(line)) {
      fail(
        file,
        lineNumber,
        "the IMAGES binding is ruled out",
        "Transform through `cf.image` (web/src/lib/images.ts). The binding's encode runs " +
          "in our isolate at 22-56 ms of CPU against a 10 ms ceiling; `cf.image` costs " +
          "0-2 ms. ADR 0012, measured in issue #34. No test can catch this — nothing " +
          "local meters CPU.",
      );
    }

    /**
     * Rule 4: no S3 credentials and no presigned URLs.
     *
     * ADR 0012 removed both deliberately — "presigned S3 URLs, their CORS policy and their
     * credentials in the Worker are all unnecessary complexity here", since the body limit
     * is 100 MB, HTTP duration is unlimited and streaming to `R2.put()` is I/O rather than
     * CPU. The rule is not about taste: a credential in the Worker is a credential that can
     * leak, and a CORS policy on a bucket is a second access-control surface for a bucket
     * ADR 0012 requires to be private. Reintroducing either would work, which is exactly
     * why it needs a check rather than a review.
     */
    const s3 = isComment
      ? null
      : line.match(
          /@aws-sdk\/|AWS_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|R2_ACCESS_KEY|getSignedUrl\s*\(|createPresigned/,
        );
    if (s3) {
      fail(
        file,
        lineNumber,
        "S3 credentials and presigned URLs are ruled out",
        `${s3[0]} — photos stream browser to Worker to R2 through the binding (ADR 0012). ` +
          "A credential in the Worker is one that can leak, and a bucket CORS policy is a " +
          "second access-control surface on a bucket that must stay private.",
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
  `source rules ok — ${files.length} files checked for module-scope Drizzle clients, ` +
    "domain/ purity, the IMAGES binding and S3 credentials",
);
