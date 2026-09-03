#!/usr/bin/env node
/**
 * The first of ADR 0007's two unverifiable numbers: the actual gzipped Worker size,
 * against the Free plan's 3 MB limit.
 *
 *   npm run check:bundle-size
 *
 * It runs `wrangler deploy --outdir bundled/ --dry-run` for both Workers — the command the
 * ADR names — and reads the size back out of Wrangler's own report rather than measuring
 * the output directory ourselves, because what counts against the limit is what Wrangler
 * would upload, and only Wrangler knows exactly what that is.
 *
 * No account and no credentials: `--dry-run` never contacts Cloudflare. `web/` is built
 * first, because its bundle does not exist until Astro has produced it.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The Free plan's per-Worker limit. Each Worker gets its own — that is why there are two. */
const LIMIT_MB = 3;
const LIMIT_KIB = LIMIT_MB * 1024;

const WORKERS = [
  {
    name: "web",
    cwd: "web",
    // `@astrojs/cloudflare` resolves `main` and the assets directory itself and writes the
    // result here; the checked-in `web/wrangler.jsonc` alone does not describe a
    // deployable Worker.
    args: ["deploy", "--dry-run", "--outdir", "bundled", "--config", "./dist/server/wrangler.json"],
    build: ["astro", "build"],
  },
  {
    name: "digest",
    cwd: "digest",
    args: ["deploy", "--dry-run", "--outdir", "bundled"],
    build: null,
  },
];

/** Wrangler prints `Total Upload: 714.82 KiB / gzip: 173.38 KiB`. */
const TOTAL_UPLOAD = /Total Upload:\s*([\d.]+)\s*(\w+)\s*\/\s*gzip:\s*([\d.]+)\s*(\w+)/;

function toKiB(value, unit) {
  const n = Number(value);
  if (unit === "KiB") return n;
  if (unit === "MiB") return n * 1024;
  if (unit === "B") return n / 1024;
  throw new Error(`Unrecognised size unit from Wrangler: ${unit}`);
}

function run(command, args, cwd) {
  return execFileSync("npx", [command, ...args], {
    cwd: new URL(`${cwd}/`, new URL("..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
  });
}

const results = [];

for (const worker of WORKERS) {
  if (worker.build) {
    process.stderr.write(`building ${worker.name}…\n`);
    run(worker.build[0], worker.build.slice(1), worker.cwd);
  }

  process.stderr.write(`measuring ${worker.name}…\n`);
  // Wrangler writes its report to stdout; strip ANSI so the regex sees plain text.
  const output = run("wrangler", worker.args, worker.cwd).replace(
    // eslint-disable-next-line no-control-regex
    /\[[0-9;]*m/g,
    "",
  );

  const match = output.match(TOTAL_UPLOAD);
  if (!match) {
    console.error(output);
    throw new Error(
      `Could not find "Total Upload" in Wrangler's output for ${worker.name}. ` +
        "Wrangler may have changed its report format; update TOTAL_UPLOAD above.",
    );
  }

  results.push({
    worker: worker.name,
    rawKiB: toKiB(match[1], match[2]),
    gzipKiB: toKiB(match[3], match[4]),
  });
}

console.log(`\nWorker bundle size (limit: ${LIMIT_MB} MB gzipped, per Worker)\n`);
console.log("  worker    raw          gzipped      of limit");
let overLimit = false;
for (const { worker, rawKiB, gzipKiB } of results) {
  const pct = (gzipKiB / LIMIT_KIB) * 100;
  if (gzipKiB > LIMIT_KIB) overLimit = true;
  console.log(
    `  ${worker.padEnd(9)} ${`${rawKiB.toFixed(2)} KiB`.padEnd(12)} ` +
      `${`${gzipKiB.toFixed(2)} KiB`.padEnd(12)} ${pct.toFixed(1)}%`,
  );
}

if (overLimit) {
  console.error("\nA Worker is over the 3 MB gzipped limit and will not deploy.");
  process.exit(1);
}

console.log("\nBoth Workers are inside the limit.");
