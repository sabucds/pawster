#!/usr/bin/env node
/**
 * Seven structural rules that no test can enforce, checked over the source instead.
 *
 * All seven exist because the thing they forbid *passes* at runtime. A module-scope Drizzle
 * client runs fine locally and breaks in production; a `db/` import inside `domain/` is just
 * an import; a query that rewrites a shelter's slug succeeds and quietly breaks every URL an
 * adopter already held; a query that selects a shelter's account email into something public
 * succeeds and publishes a credential; the `env.IMAGES` binding transforms images correctly
 * while spending five times the Worker's CPU budget; S3 credentials in the Worker work
 * exactly as well as not having them, minus the credential that can leak; and an
 * `authenticate()` call on an admin route would work perfectly, which is the problem — it
 * would be an admin session, and ADR 0002 built none.
 *
 * None has a failing test to point at. Four of them share a sharper reason for that, worth
 * naming: the slug, account-email and admin-cookie rules could each have a test *per route*,
 * which is the problem, because the route that breaks them is the one nobody has written
 * yet — and the `IMAGES` rule could have no test at all, because nothing available locally
 * meters CPU (`docs/testing-seams.md`).
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

/**
 * The one function allowed to write `shelters.slug`.
 *
 * `db/src/schema.ts`: the slug is "generated once at registration from the display name and
 * **never rewritten afterwards**", because it is an address adopters and search engines
 * already hold and ADR 0015 promises a departed shelter's archive pages stay reachable. That
 * file also admits the gap this rule closes: "Nothing in SQLite enforces immutability, so the
 * enforcement is narrower and worth stating: no query outside registration writes this
 * column." Stating it is what this makes mechanical.
 */
const SLUG_INSERT_EXEMPT = "web/src/lib/auth/store.ts";

/**
 * The balanced `(...)` starting at the `(` at or after `from`, or `null` if unbalanced.
 *
 * Needed because the thing being looked for is a property inside a multi-line object
 * literal, and the line-by-line pass below cannot see one. Parentheses are counted rather
 * than braces so that `.set({ ... })` and `.values([{ ... }, { ... }])` are both one region.
 * Quotes are not tracked: a `(` inside a string would throw the count off, and the failure
 * direction is a region that ends early or late rather than a rule that stops applying.
 */
function balanced(source, from) {
  const open = source.indexOf("(", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Rule 3: nothing outside registration writes `shelters.slug`.
 *
 * Two shapes, checked over the whole file text rather than per line:
 *
 *   .set({ slug })                       // an UPDATE — never allowed, anywhere
 *   db.insert(shelters).values({ slug }) // an INSERT — only in registerShelter()
 *
 * The `.set(` form carries no exemption at all — not even for a test — because there is no
 * legitimate one: the slug is written when the row is created and at no later moment, and a
 * test that rewrote one would be asserting the behaviour this rule forbids.
 *
 * The insert form is exempted for exactly one source file, rather than for the whole of
 * `web/src/lib/auth/`, so that a second write path added next door still fails. It is also
 * exempted for tests, which is not a concession: a test seeding a `shelters` row is
 * *creating* a shelter and choosing its slug, which is the one act the rule permits. What it
 * must not do is change one afterwards, and the `.set(` half still stops that.
 *
 * Raw SQL is checked too. A migration writing the column is fine and expected — `0001`
 * backfills it — and `db/migrations` is not scanned, so nothing needs exempting there.
 */
function checkSlugWrites(file, relPath, source) {
  const lineOf = (index) => source.slice(0, index).split("\n").length;

  for (const match of source.matchAll(/\.set\s*\(/g)) {
    const region = balanced(source, match.index);
    if (region && /\bslug\b/.test(region)) {
      fail(
        file,
        lineOf(match.index),
        "writes shelters.slug",
        "A slug is generated once at registration and never rewritten — it is an address " +
          "adopters and search engines already hold, and ADR 0015 promises a departed " +
          "shelter's archive pages stay reachable. The display name is the field that " +
          "changes; see db/src/schema.ts.",
      );
    }
  }

  const isTest = /\.test\.ts$/.test(relPath) || relPath.includes("/test/");
  if (relPath === SLUG_INSERT_EXEMPT || isTest) return;

  for (const match of source.matchAll(
    /\.insert\s*\(\s*shelters\s*\)[\s\S]{0,120}?\.values\s*\(/g,
  )) {
    const region = balanced(source, match.index + match[0].length - 1);
    if (region && /\bslug\b/.test(region)) {
      fail(
        file,
        lineOf(match.index),
        "writes shelters.slug",
        `Only ${SLUG_INSERT_EXEMPT}'s registerShelter() may write a slug, because that is ` +
          "the one moment it is chosen. See db/src/schema.ts.",
      );
    }
  }

  const rawUpdate = source.match(/update\s+`?shelters`?\s+set[\s\S]{0,200}?\bslug\b/i);
  if (rawUpdate) {
    fail(
      file,
      lineOf(rawUpdate.index),
      "writes shelters.slug in raw SQL",
      "Same rule, and the same reason: no query outside registration writes this column.",
    );
  }
}

/**
 * The only source files allowed to read `shelters.account_email`.
 *
 * `CONTEXT.md`, *Account Email*: "Never published — adopters reach a shelter through its
 * contact points", and issue #52 requires it to appear "in no public response, in no page
 * source, and in no filter index". The first two are testable and tested; **the third is not,
 * because the filter index does not exist yet** (issue #56), and a requirement whose only
 * enforcement is a test that cannot be written is a requirement that quietly lapses.
 *
 * So the column itself is fenced. `web/src/lib/auth/store.ts` reads it to find the shelter an
 * address belongs to at sign-in; `web/src/lib/shelter/store.ts` reads it to render the
 * shelter's own two authenticated pages and to move it. Nothing else has a reason to, and the
 * point of the list being short is that adding to it is a deliberate edit rather than an
 * import.
 *
 * **Every page is absent from the list on purpose**, including the three authenticated ones
 * that display the address: they receive a `ShelterProfile` and never name the column. That
 * is what makes the fence worth having — a page that could name it by writing its own select
 * would fence nothing, and `panel.astro` had exactly such a select until this rule found it.
 */
const ACCOUNT_EMAIL_READERS = [
  /** Declares the column. Defining it is not reading it, and something has to. */
  "db/src/schema.ts",
  /** `findShelterByEmail()`: which shelter an address belongs to, at sign-in. */
  "web/src/lib/auth/store.ts",
  /** `readShelterProfile()` renders it to the shelter; `changeAccountEmail()` moves it. */
  "web/src/lib/shelter/store.ts",
];

/**
 * Rule 4: only {@link ACCOUNT_EMAIL_READERS} may name the account-email column.
 *
 * Matches the Drizzle reference (`shelters.accountEmail`) and the raw column name
 * (`account_email`), which between them are every way to reach it. Tests are exempt: a test
 * asserting the address is *absent* from a public page has to name it to do so, and several
 * do.
 *
 * A false positive here is a file that mentions the column without reading it, which is
 * cheap to resolve — either it does not need to, or it is a reader and belongs on the list.
 */
function checkAccountEmailReaders(file, relPath, source) {
  if (/\.test\.ts$/.test(relPath) || relPath.includes("/test/")) return;
  if (ACCOUNT_EMAIL_READERS.includes(relPath)) return;

  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (!/shelters\.accountEmail|\baccount_email\b/.test(line)) return;
    fail(
      file,
      index + 1,
      "reads shelters.account_email",
      "The account email is a shelter's credential and is never published — not in a " +
        "public response, not in a page source, not in the filter index (issue #52). If " +
        `this file genuinely needs it, add it to ACCOUNT_EMAIL_READERS in ${relative(
          ROOT,
          fileURLToPath(import.meta.url),
        )} and say why. If it needs a shelter's public identity, that is displayName and ` +
        "its contact points.",
    );
  });
}

/**
 * The two route prefixes that are the admin surface. ADR 0002 gave the Platform Admin no
 * account: "there is no admin account, no admin role in the auth system". A cookie read
 * anywhere under these paths is an admin session growing back.
 */
const ADMIN_ROUTE_PREFIXES = ["web/src/pages/admin/", "web/src/pages/api/admin/"];

/**
 * Rule 7: nothing under the admin routes touches a cookie.
 *
 * This is here rather than in a test for the reason the slug and account-email rules are:
 * the route that breaks it is the one nobody has written yet. A test can assert that
 * *today's* two admin pages ignore a session cookie — `admin-verification.test.ts` does —
 * and it can say nothing about the third page, which is exactly where an `authenticate()`
 * call would look like a convenience. The whole admin credential is the signed token in the
 * URL, verified with `verifyAdminLink()`.
 *
 * Comment lines are skipped, because the decision has to be writable about: both admin
 * pages' module comments name the absence in order to explain it, and a rule that fired on
 * prose would make the reasoning unwritable. The same heuristic rules 5 and 6 use.
 */
function checkAdminRoutesTakeNoCookie(file, relPath, source) {
  if (!ADMIN_ROUTE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return;

  source.split("\n").forEach((line, index) => {
    if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
    /**
     * `cookie` anywhere in the line rather than as a whole word, because the ways in are
     * spelled as one identifier: `readCookie(...)`, `getSetCookie()`, `SESSION_COOKIE`,
     * `set-cookie`. A word-boundary form was written first and caught none of them — it let
     * `readCookie(Astro.request, SESSION_COOKIE)` through, which is the exact line the rule
     * exists to stop. Comments are already skipped above, so the loose match costs nothing:
     * the prose that explains the absence is not scanned.
     */
    const match = line.match(/cookie|\bauthenticate\s*\(/i);
    if (!match) return;
    fail(
      file,
      index + 1,
      "an admin route reads a cookie",
      `${match[0]} — the admin surface has no session and no account (ADR 0002). Its whole ` +
        "credential is the signed token in the URL, verified with verifyAdminLink(). A " +
        "cookie read here is an admin session growing back, and it would work.",
    );
  });
}

for (const file of files) {
  const relPath = relative(ROOT, file);
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const inDomain = relPath.startsWith("domain/");

  checkSlugWrites(file, relPath, source);
  checkAccountEmailReaders(file, relPath, source);
  checkAdminRoutesTakeNoCookie(file, relPath, source);

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
     * Rule 5: the image pipeline is `cf.image`, and the `IMAGES` binding is ruled out
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
     * Rule 6: no S3 credentials and no presigned URLs.
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
    "domain/ purity, writes to shelters.slug, reads of the account-email column, " +
    "the IMAGES binding, S3 credentials and cookies on an admin route",
);
