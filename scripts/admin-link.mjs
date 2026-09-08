#!/usr/bin/env node
/**
 * Mint an admin link, and perform the one act no link in an inbox can perform.
 *
 * There is no admin account and no admin login (ADR 0002), so the two things a maintainer
 * cannot do from a browser are: get a pending-list link when no registration has arrived
 * recently to carry one, and revoke a shelter. This script is both.
 *
 *   node scripts/admin-link.mjs pending
 *   node scripts/admin-link.mjs decide --shelter <shelter-id>
 *   node scripts/admin-link.mjs revoke --shelter <shelter-id> \
 *        --evidence "instagram.com/... deleted; number now answers as a different org" \
 *        [--methods instagram,call]
 *
 * Reads `ADMIN_LINK_SECRET`, `PAWSTER_ADMIN_EMAIL` and `SITE_ORIGIN` from the environment —
 * the same three values `.env.example` records and `wrangler secret put` / `wrangler.jsonc`
 * carry into the Worker. `scripts/.gitignore` ignores `.env`, so the usual shape is
 * `set -a; . ./.env; set +a` before running this.
 *
 * ## Why `revoke` posts rather than writing SQL
 *
 * A hand-written `INSERT` into `verifications` would delist every animal a shelter has
 * published and send the shelter nothing. Issue #45's story is that a revocation arrives "as
 * a real email inviting a reply, so that a mistake about me is correctable by a human", so
 * this goes through `POST /api/admin/revoke`, which goes through the one function that writes
 * an entry *and* mails the shelter. The bar stays higher than a button's: it needs the
 * platform's own signing secret and a command.
 *
 * ## Why the token format is implemented twice
 *
 * `web/src/lib/verification/link.ts` mints the same shape, and this file mints it again in
 * about fifteen lines rather than importing it. Importing would mean running TypeScript from
 * a plain Node script, which the repo's `engines` field does not promise (`node >= 20`, where
 * type stripping is behind a flag).
 *
 * The duplication is safe in the one way that matters: **drift fails closed and immediately.**
 * A token this file mints differently is a token the Worker's `verifyAdminLink()` rejects, so
 * the first command a maintainer runs after a divergence prints a 404 — it cannot mint
 * something that is quietly wrong, or that authorises more than it should. The signature is
 * the whole format, and the format is asserted from the Worker's side by
 * `web/test/verification-policy.test.ts`.
 */

import { argv, env, exit } from "node:process";

const USAGE = `usage:
  node scripts/admin-link.mjs pending
  node scripts/admin-link.mjs decide --shelter <shelter-id>
  node scripts/admin-link.mjs revoke --shelter <shelter-id> --evidence <text> [--methods a,b]

environment:
  ADMIN_LINK_SECRET     signs the link (a Worker secret; keep it out of shell history)
  PAWSTER_ADMIN_EMAIL   the address decisions are attributed to
  SITE_ORIGIN           e.g. https://pawster.dpdns.org
`;

/** Mirrors `TTL_MS` in web/src/lib/verification/link.ts. */
const TTL_MS = {
  decision: 7 * 24 * 60 * 60_000,
  pending: 24 * 60 * 60_000,
  revocation: 24 * 60 * 60_000,
};

const PATHS = {
  decision: "/admin/decide",
  pending: "/admin/pending",
  revocation: "/api/admin/revoke",
};

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  exit(1);
}

function readFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!name?.startsWith("--")) fail(`unexpected argument: ${name}`);
    const value = args[i + 1];
    if (value === undefined) fail(`${name} needs a value`);
    flags[name.slice(2)] = value;
  }
  return flags;
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/** `HMAC-SHA256(secret, "admin:" || message)`, base64url — the `admin` label in auth/crypto.ts. */
async function sign(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`admin:${message}`));
  return toBase64Url(new Uint8Array(signature));
}

async function mint(secret, { kind, shelterId, admin }) {
  const payload = { k: kind, a: admin, x: Date.now() + TTL_MS[kind] };
  if (shelterId) payload.s = shelterId;
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(secret, encoded)}`;
}

const [command, ...rest] = argv.slice(2);
if (!command) fail("say what to mint");

const flags = readFlags(rest);
/**
 * Both spellings of each value, because two files record them under different names and a
 * maintainer should not have to know which: `.env.example` keeps the repo's own record under
 * `PAWSTER_*` (as it already does for `PAWSTER_LINK_SIGNING_KEY`), while the Worker holds the
 * same values under the names `web/src/env.d.ts` declares. `set -a; . ./.env; set +a` then
 * works with no re-exporting.
 */
const secret = env.ADMIN_LINK_SECRET ?? env.PAWSTER_ADMIN_LINK_SECRET;
const admin = env.PAWSTER_ADMIN_EMAIL ?? env.ADMIN_EMAIL;
const origin =
  env.SITE_ORIGIN ?? (env.PAWSTER_DOMAIN ? `https://${env.PAWSTER_DOMAIN}` : undefined);

if (!secret) fail("ADMIN_LINK_SECRET (or PAWSTER_ADMIN_LINK_SECRET) is not set");
if (!admin) fail("PAWSTER_ADMIN_EMAIL is not set — it is who the decision is attributed to");
if (!origin) fail("SITE_ORIGIN (or PAWSTER_DOMAIN) is not set");

if (command === "pending") {
  const token = await mint(secret, { kind: "pending", admin });
  console.log(`${origin}${PATHS.pending}?t=${encodeURIComponent(token)}`);
  console.log("\nGood for 24 hours. It lists every waiting shelter, so do not forward it.");
  exit(0);
}

if (command === "decide") {
  if (!flags.shelter) fail("--shelter <shelter-id> is required");
  const token = await mint(secret, {
    kind: "decision",
    shelterId: flags.shelter,
    admin,
  });
  console.log(`${origin}${PATHS.decision}?t=${encodeURIComponent(token)}`);
  console.log("\nGood for 7 days. Opening it decides nothing.");
  exit(0);
}

if (command === "revoke") {
  if (!flags.shelter) fail("--shelter <shelter-id> is required");
  if (!flags.evidence) {
    fail("--evidence <text> is required: a revocation with no reasoning cannot answer an appeal");
  }

  const token = await mint(secret, {
    kind: "revocation",
    shelterId: flags.shelter,
    admin,
  });

  const body = new URLSearchParams({
    t: token,
    outcome: "Revoked",
    evidence: flags.evidence,
  });
  for (const method of (flags.methods ?? "").split(",").filter(Boolean)) {
    body.append("methods", method);
  }

  const response = await fetch(`${origin}${PATHS.revocation}`, {
    method: "POST",
    // The header a browser would send on a form post, because Astro's `security.checkOrigin`
    // refuses one without it — a CSRF defence worth keeping on an endpoint that revokes.
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
    },
    body,
  });

  console.log((await response.text()).trimEnd());
  exit(response.ok ? 0 : 1);
}

fail(`unknown command: ${command}`);
