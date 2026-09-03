#!/usr/bin/env node
/**
 * The second of ADR 0007's two unverifiable numbers: actual per-request CPU on the SSR
 * routes, against the Free plan's 10 ms ceiling.
 *
 *   npm run check:ssr-cpu
 *
 * ## How it measures
 *
 * `workerd` does not report per-request CPU to the Worker or to any local log, so this
 * measures the CPU of the `wrangler dev` process tree across a run of requests and divides.
 * That total includes HTTP parsing, the local proxy and the asset router as well as our
 * render — so the raw figure is an upper bound, not the answer.
 *
 * The prerendered page is the control that turns it into an answer. `/` is served by the
 * asset router **without invoking Worker code** (ADR 0007), so it pays every cost the SSR
 * request pays except the render itself. The difference between the two per-request
 * figures is the Worker's own CPU, and it is arrived at by subtraction rather than by
 * trusting an absolute number from a machine that is not Cloudflare's.
 *
 * ## What it is not
 *
 * This is local `workerd` on this developer's machine, not an edge isolate. Treat it as an
 * order of magnitude and a regression detector, not as the compliance number: the
 * authoritative measurement needs a deployed Worker, which this repo deliberately cannot
 * do — the whole suite runs with no Cloudflare account and no credentials.
 *
 * **Nothing enforces the 10 ms ceiling.** Not this script, which only reports, and not the
 * test suite, which cannot see CPU at all. See `docs/testing-seams.md`.
 */

import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = new URL("..", import.meta.url);
const WEB = new URL("web/", ROOT);
const CONFIG = "./dist/server/wrangler.json";
const PERSIST = fileURLToPath(new URL(".wrangler/measure-state", ROOT));

/** Cloudflare's Free-plan per-invocation CPU ceiling. */
const CEILING_MS = 10;

const PORT = 8788 + Math.floor(Math.random() * 200);
const WARMUP = 100;
const SAMPLES = 500;

const ROUTES = [
  { label: "prerendered /", path: "/", control: true },
  { label: "SSR /animales/:id", path: "/animales/measure-1", control: false },
];

function npx(args, options = {}) {
  return execFileSync("npx", args, {
    cwd: fileURLToPath(WEB),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
    ...options,
  });
}

/** Total CPU seconds of `pid` and every descendant. macOS `ps` reports `MM:SS.ss`. */
function treeCpuSeconds(rootPid) {
  const rows = execFileSync("ps", ["-Ao", "pid=,ppid=,time="], {
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 3);

  const children = new Map();
  const cpu = new Map();
  for (const [pid, ppid, time] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    const [minutes, seconds] = time.split(":");
    cpu.set(pid, Number(minutes) * 60 + Number(seconds));
  }

  let total = 0;
  const queue = [String(rootPid)];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += cpu.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`Server did not come up at ${url}`);
}

async function hit(url, times) {
  for (let i = 0; i < times; i++) {
    const response = await fetch(url);
    await response.arrayBuffer();
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}; measurement aborted`);
    }
  }
}

process.stderr.write("building web…\n");
npx(["astro", "build"]);

process.stderr.write("applying migrations to a local D1…\n");
npx([
  "wrangler", "d1", "migrations", "apply", "pawster",
  "--local", "--config", CONFIG, "--persist-to", PERSIST,
]);

process.stderr.write("seeding one animal…\n");
npx([
  "wrangler", "d1", "execute", "pawster",
  "--local", "--config", CONFIG, "--persist-to", PERSIST,
  "--command",
  `DELETE FROM animals; DELETE FROM shelters;
   INSERT INTO shelters (id, display_name, account_email, country_code, created_at)
     VALUES ('measure-s', 'Refugio de Medición', 'medicion@example.org', 'VE', 0);
   INSERT INTO animals (id, shelter_id, name, species, estimated_birth_date, region, last_confirmed_at, listed)
     VALUES ('measure-1', 'measure-s', 'Canela', 'dog', 1735689600000, 'Miranda', 1756512000000, 1);`,
]);

process.stderr.write(`starting wrangler dev on :${PORT}…\n`);
const server = spawn(
  "npx",
  [
    "wrangler", "dev",
    "--config", CONFIG,
    "--port", String(PORT),
    "--persist-to", PERSIST,
    "--show-interactive-dev-session", "false",
  ],
  {
    cwd: fileURLToPath(WEB),
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const results = [];
try {
  await waitForServer(`http://localhost:${PORT}/`);

  for (const route of ROUTES) {
    const url = `http://localhost:${PORT}${route.path}`;
    // Warm up first: the first requests pay for module instantiation and JIT, which is
    // startup cost rather than per-request cost.
    await hit(url, WARMUP);

    const before = treeCpuSeconds(server.pid);
    await hit(url, SAMPLES);
    const after = treeCpuSeconds(server.pid);

    results.push({ ...route, msPerRequest: ((after - before) * 1000) / SAMPLES });
  }
} finally {
  server.kill("SIGTERM");
}

const control = results.find((r) => r.control);
const ssr = results.find((r) => !r.control);
const attributable = ssr.msPerRequest - control.msPerRequest;

console.log(`\nPer-request CPU, ${SAMPLES} samples each, local workerd\n`);
for (const { label, msPerRequest } of results) {
  console.log(`  ${label.padEnd(20)} ${msPerRequest.toFixed(3)} ms  (whole process tree)`);
}
console.log(
  `\n  render attributable to the Worker: ${attributable.toFixed(3)} ms` +
    `  — ${((attributable / CEILING_MS) * 100).toFixed(1)}% of the ${CEILING_MS} ms ceiling`,
);
console.log(
  "\n  Indicative only: local workerd, not an edge isolate, and nothing here enforces\n" +
    "  the ceiling. See docs/testing-seams.md.",
);
