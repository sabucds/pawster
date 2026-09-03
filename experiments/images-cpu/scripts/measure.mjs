#!/usr/bin/env node
/**
 * Drives the probe Worker and reads the CPU each invocation actually spent.
 *
 * CPU time cannot be measured from inside a Worker: `Date.now()` advances only
 * on I/O and `performance.now()` is coarsened, both deliberately, against timing
 * attacks. The authoritative number lives in the invocation's trace event —
 * `CPUTimeMs` in the Logpush dataset, surfaced at the top level of what
 * `wrangler tail --format json` streams — so this script tails the Worker while
 * it drives it, and joins each response to its own trace event.
 *
 * The join key is the `bust` value, which is unique per sample and appears in the
 * request URL. That matters more than it sounds: samples are fired concurrently
 * enough that ordering cannot be trusted, and a mis-joined event would silently
 * attribute a transform's CPU to its own control.
 *
 * Usage:
 *   node scripts/measure.mjs                # deploys, measures, writes results
 *   node scripts/measure.mjs --url https://…  # measure an already-deployed probe
 *   node scripts/measure.mjs --samples 9
 */

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const SAMPLES = Number(arg("samples", "7"));
const WORKER = "pawster-images-cpu-probe";

/**
 * Every measurement is a pair: a transform and the control that does its I/O and
 * none of its encoding. `subtract` names the control, and the report prints the
 * difference, because only the difference is the answer to #34.
 */
const SCENARIOS = [
  {
    key: "noop",
    path: "/noop",
    what: "empty invocation — the isolate's own floor",
  },
  {
    key: "control:jpg",
    path: "/control/fetch?src=phone.jpg",
    what: "read the 12 MP JPEG and drain every chunk through JS, no transform",
  },
  {
    /* The binding's honest control: it is handed a stream and never JS-reads the
     * source, so what it pays on top of this is encode and nothing else. */
    key: "control:jpg:cancel",
    path: "/control/fetch?src=phone.jpg&mode=cancel",
    what: "read the 12 MP JPEG and discard it unread — the source-read floor",
  },
  {
    key: "binding:jpg:144:jpeg",
    path: "/binding?src=phone.jpg&w=144&h=144&fit=cover&fmt=jpeg",
    what: "BINDING — 144x144 JPEG digest thumbnail (ADR 0012's primary derivative)",
    subtract: "control:jpg:cancel",
    transformations: true,
  },
  {
    key: "cfimage:jpg:144:jpeg",
    path: "/cfimage?src=phone.jpg&w=144&h=144&fit=cover&fmt=jpeg",
    what: "cf.image — the same 144x144 JPEG thumbnail",
    subtract: "noop",
    transformations: true,
  },
  {
    key: "binding:jpg:1280:webp",
    path: "/binding?src=phone.jpg&w=1280&fmt=webp",
    what: "BINDING — 1280px WebP detail image (the heaviest derivative in the set)",
    subtract: "control:jpg:cancel",
    transformations: true,
  },
  {
    key: "cfimage:jpg:1280:webp",
    path: "/cfimage?src=phone.jpg&w=1280&fmt=webp",
    what: "cf.image — the same 1280px WebP",
    subtract: "noop",
    transformations: true,
  },
  {
    key: "control:heic",
    path: "/control/fetch?src=phone.heic",
    what: "fetch the HEIC and drain it, no transform",
  },
  {
    key: "binding:heic:144:jpeg",
    path: "/binding?src=phone.heic&w=144&h=144&fit=cover&fmt=jpeg",
    what: "BINDING — HEIC in, 144x144 JPEG out (what an iPhone actually uploads)",
    subtract: "control:heic",
    transformations: true,
  },
  {
    key: "cfimage:heic:144:jpeg",
    path: "/cfimage?src=phone.heic&w=144&h=144&fit=cover&fmt=jpeg",
    what: "cf.image — HEIC in, 144x144 JPEG out",
    subtract: "noop",
    transformations: true,
  },
  {
    key: "binding:gravity-auto",
    path: "/binding?src=phone.jpg&w=144&h=144&fit=cover&gravity=auto&fmt=jpeg",
    what: "BINDING — gravity=auto, undocumented for .transform()",
    subtract: "control:jpg:cancel",
    transformations: true,
  },
  {
    key: "cfimage:gravity-auto",
    path: "/cfimage?src=phone.jpg&w=144&h=144&fit=cover&gravity=auto&fmt=jpeg",
    what: "cf.image — gravity=auto, the only documented form",
    subtract: "noop",
    transformations: true,
  },
];

const ORIGIN_SCENARIOS = [
  {
    key: "cfimage-origin:144:jpeg",
    path: "/cfimage-origin?src=phone.jpg&w=144&h=144&fit=cover&fmt=jpeg",
    what: "cf.image whose source is a token-gated WORKER route, not a public asset",
    subtract: "noop",
    transformations: true,
  },
];

/** One-shot probes: the answer is the response, not a distribution. */
const ONE_SHOTS = [
  {
    key: "cfimage-origin-unsigned",
    path: "/cfimage-origin-unsigned?src=phone.jpg&w=144&fmt=jpeg",
    what: "the same route with a bad token - proves the gate actually gates",
  },
  { key: "info:jpg", path: "/info?src=phone.jpg", what: "binding .info() on the JPEG" },
  {
    key: "info:heic",
    path: "/info?src=phone.heic",
    what: "binding .info() on the HEIC — does the binding admit HEIC at all?",
  },
  {
    key: "subreq:49+fetch",
    path: "/subreq?n=49&tail=fetch",
    what: "49 fetches + 1 fetch = 50 — control, expected to pass on Free",
  },
  {
    key: "subreq:50+fetch",
    path: "/subreq?n=50&tail=fetch",
    what: "50 fetches + 1 fetch = 51 — control, expected to FAIL, proves where the wall is",
  },
  {
    key: "subreq:49+binding",
    path: "/subreq?n=49&tail=binding",
    what: "49 fetches + source fetch (=50, allowed) + binding — fails if the binding spends a subrequest",
    transformations: true,
  },
  {
    /* The pair pins the cost rather than merely detecting it: at n=48 the binding
     * is the 50th subrequest, so it must pass if the binding costs exactly one,
     * and fail if it costs two or more. */
    key: "subreq:48+binding",
    path: "/subreq?n=48&tail=binding",
    what: "48 fetches + source fetch (=49) + binding — passes only if the binding costs exactly 1",
    transformations: true,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deploy() {
  process.stderr.write("deploying probe Worker…\n");
  const out = execFileSync("npx", ["wrangler", "deploy"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  if (!m) {
    console.error(out);
    throw new Error("could not find the workers.dev URL in wrangler's output");
  }
  return m[0];
}

/**
 * Trace events name CPU differently depending on surface (`CPUTimeMs` in the
 * Logpush dataset, `$workers.cpuTimeMs` in the query builder), so rather than
 * betting on one spelling this finds the field by shape. If it finds nothing the
 * run still completes and says so — the dashboard's Query Builder is the fallback.
 */
function pluckTiming(ev) {
  const hit = (re) => {
    for (const [k, v] of Object.entries(ev)) {
      if (re.test(k) && typeof v === "number") return v;
    }
    return undefined;
  };
  return { cpuMs: hit(/cpu/i), wallMs: hit(/wall/i) };
}

/**
 * `wrangler tail --format json` is not NDJSON: it pretty-prints each trace event
 * across many lines. A line-oriented reader silently collects nothing from it,
 * which is a quiet enough failure to look like "the Worker emitted no events".
 * So split the stream on brace depth instead, tracking string state so a `{`
 * inside a header value cannot desynchronise the count.
 */
function startTail() {
  const child = spawn("npx", ["wrangler", "tail", WORKER, "--format", "json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = [];
  let buf = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const ch of chunk) {
      if (depth > 0 || ch === "{") buf += ch;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        if (depth === 0) {
          buf = "{";
          start = 0;
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start === 0) {
          try {
            events.push(JSON.parse(buf));
          } catch {
            /* a banner that happened to contain braces; ignore */
          }
          buf = "";
          start = -1;
        }
      }
    }
  });
  child.stderr.on("data", (d) => process.stderr.write(`  [tail] ${d}`));
  return { child, events };
}

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p50: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
    mean: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(3)),
  };
};

async function main() {
  const base = arg("url") ?? deploy();
  process.stderr.write(`probe at ${base}\n`);

  /* A newly registered workers.dev subdomain resolves in DNS minutes before its
   * certificate exists, so the first run of this script fired every scenario
   * into a TLS handshake failure and reported an empty table. Prove the probe
   * answers before spending a single metered transformation on it. */
  process.stderr.write("checking the probe is reachable…\n");
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}/noop?bust=preflight-${Date.now()}`);
      if (r.ok) break;
      throw new Error(`/noop returned ${r.status}`);
    } catch (e) {
      if (i >= 20) {
        console.error(
          `\nthe probe never answered: ${e}\n\n` +
            "If this is a TLS handshake failure, the workers.dev subdomain is new and its\n" +
            "certificate is still provisioning — wait a few minutes and re-run.\n",
        );
        process.exit(1);
      }
      await sleep(15000);
    }
  }

  const { child, events } = startTail();
  process.stderr.write("waiting for the tail session to attach…\n");
  await sleep(8000);

  const samples = []; // { key, bust, response }

  // A cold start's CPU includes script parse and module evaluation, which is a
  // real cost but not the transform's, so every scenario is warmed once and that
  // first sample is reported separately rather than averaged in.
  const fire = async (key, path, bust) => {
    const url = `${base}${path}${path.includes("?") ? "&" : "?"}bust=${bust}`;
    const started = Date.now();
    let body, status;
    try {
      const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (e) {
      status = 0;
      body = { fetchError: String(e) };
    }
    samples.push({ key, bust, url, status, body, elapsedMs: Date.now() - started });
  };

  for (const sc of [...SCENARIOS, ...ORIGIN_SCENARIOS]) {
    process.stderr.write(`  ${sc.key} …\n`);
    for (let i = 0; i < SAMPLES + 1; i++) {
      // A fresh bust per sample forces a genuine encode: an identical repeat is
      // served from cache and would read as free.
      await fire(sc.key, sc.path, `${sc.key}-${i}-${Date.now()}`);
      await sleep(400);
    }
  }
  for (const sc of ONE_SHOTS) {
    process.stderr.write(`  ${sc.key} …\n`);
    await fire(sc.key, sc.path, `${sc.key}-${Date.now()}`);
    await sleep(600);
  }

  process.stderr.write("draining the tail (trace events lag the response)…\n");
  await sleep(12000);
  child.kill();

  // Join on the bust, never on order.
  const byBust = new Map();
  for (const ev of events) {
    const url = ev?.event?.request?.url ?? "";
    const m = url.match(/[?&]bust=([^&]+)/);
    if (!m) continue;
    byBust.set(decodeURIComponent(m[1]), ev);
  }

  const measured = samples.map((s) => {
    const ev = byBust.get(s.bust);
    const t = ev ? pluckTiming(ev) : {};
    return { ...s, outcome: ev?.outcome, cpuMs: t.cpuMs, wallMs: t.wallMs, matched: !!ev };
  });

  const all = [...SCENARIOS, ...ORIGIN_SCENARIOS, ...ONE_SHOTS];
  const summary = {};
  for (const sc of all) {
    const rows = measured.filter((m) => m.key === sc.key);
    const [cold, ...warm] = rows;
    const cpu = warm.map((r) => r.cpuMs).filter((v) => typeof v === "number");
    summary[sc.key] = {
      what: sc.what,
      subtract: sc.subtract,
      coldCpuMs: cold?.cpuMs,
      cpu: stats(cpu),
      wall: stats(warm.map((r) => r.wallMs).filter((v) => typeof v === "number")),
      outcomes: [...new Set(rows.map((r) => r.outcome))],
      statuses: [...new Set(rows.map((r) => r.status))],
      bodies: rows.slice(0, 1).map((r) => r.body),
      unmatched: rows.filter((r) => !r.matched).length,
    };
  }

  // The whole point: the transform's own CPU, with its control's cost removed.
  for (const sc of all) {
    if (!sc.subtract) continue;
    const a = summary[sc.key]?.cpu;
    const b = summary[sc.subtract]?.cpu;
    if (a && b) {
      summary[sc.key].attributableCpuMs = {
        p50: Number((a.p50 - b.p50).toFixed(3)),
        min: Number((a.min - b.min).toFixed(3)),
        mean: Number((a.mean - b.mean).toFixed(3)),
      };
    }
  }

  const anyCpu = Object.values(summary).some((s) => s.cpu);
  const result = {
    ranAt: new Date().toISOString(),
    base,
    samplesPerScenario: SAMPLES,
    cpuFieldFound: anyCpu,
    freePlanCpuLimitMs: 10,
    summary,
    raw: measured,
  };

  const outPath = join(root, "results.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

  /* ------------------------------- report ------------------------------- */
  const pad = (s, n) => String(s ?? "—").padEnd(n);
  console.log(`\n# Images transformation CPU — ${result.ranAt}\n`);
  console.log(`probe: ${base}`);
  console.log(`Free-plan CPU ceiling: 10 ms per invocation\n`);
  if (!anyCpu) {
    console.log(
      "!! No CPU field appeared in any trace event. Read the numbers instead from\n" +
        "   the dashboard: Workers & Pages -> Observability -> Query Builder, field\n" +
        "   $workers.cpuTimeMs, filtered to this Worker. results.json holds the raw\n" +
        "   events so the join can be redone by hand.\n",
    );
  }
  console.log(
    `${pad("scenario", 26)} ${pad("cold", 8)} ${pad("cpu p50", 9)} ${pad("cpu max", 9)} ${pad("minus control", 14)} outcome`,
  );
  console.log("-".repeat(96));
  for (const sc of all) {
    const s = summary[sc.key];
    const d = s.attributableCpuMs;
    console.log(
      `${pad(sc.key, 26)} ${pad(s.coldCpuMs, 8)} ${pad(s.cpu?.p50, 9)} ${pad(s.cpu?.max, 9)} ${pad(d ? `${d.p50 >= 0 ? "+" : ""}${d.p50} ms` : "", 14)} ${(s.outcomes ?? []).join(",")}`,
    );
  }
  console.log(`\nfull detail, including every response body: ${outPath}`);
  console.log(
    `\nWhen you are done, tear the probe down:  npx wrangler delete --name ${WORKER}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
