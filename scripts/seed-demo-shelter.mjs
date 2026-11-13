#!/usr/bin/env node
/**
 * Print the SQL that creates the demo shelter (ADR 0021), for `wrangler d1 execute --file`.
 *
 *   node scripts/seed-demo-shelter.mjs \
 *     --email maintainer@example.org \
 *     --whatsapp "+58 412 5550001" \
 *     [--decided-by admin@example.org] [--region Miranda] > demo.sql
 *   npx wrangler d1 execute pawster --remote --file demo.sql   # from web/
 *
 * It writes three rows: the shelter with `demo = 1`, one WhatsApp contact point, and one
 * Verified entry in the verification log. Those are the three shelter-level facts the listing
 * rule needs, so the shelter's animals list as soon as they are published. Publishing them is
 * left to the normal shelter UI: sign in at /refugios/entrar with `--email`, then publish. That
 * runs the real upload, derivative and index path, which is part of what the first deploy is
 * meant to prove.
 *
 * **Why the Verified entry is written here, with no methods.** The admin decision page refuses
 * a Verified outcome without at least one method, and every method (instagram, website, press,
 * registry, call) means "the admin checked a real public presence". None of them is true of a
 * shelter the maintainer made up. An empty `methods` with evidence that says what happened is
 * the honest entry. `decodeMethods('')` reads it as no methods, so the admin pages show the
 * evidence and an empty list.
 *
 * **Idempotent.** The ids are fixed, every insert is guarded, and the verification entry is
 * written only if the shelter has none. Running the file twice changes nothing. To change the
 * contact point afterwards, use the shelter's profile page like any shelter would.
 *
 * `--email` is the demo shelter's account email, so it receives the sign-in codes and the
 * confirmation nudges. It must not be any other shelter's account email (the column is unique,
 * and the insert is silently skipped if it collides; check the output of the final SELECT).
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    whatsapp: { type: "string" },
    "decided-by": { type: "string" },
    region: { type: "string", default: "Miranda" },
  },
});

if (!values.email || !values.whatsapp) {
  console.error(
    "usage: node scripts/seed-demo-shelter.mjs --email <inbox> --whatsapp <number> [--decided-by <admin>] [--region <region>]",
  );
  process.exit(2);
}

const SHELTER_ID = "demo-shelter";
const DISPLAY_NAME = "Refugio de demostración";
const SLUG = "refugio-de-demostracion";
const now = Date.now();

/** SQL string literal. Every value here is typed by the maintainer, but quote it properly anyway. */
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;

// The same canonical form `canonicalCitedContactPoints()` writes in web/src/lib/verification/policy.ts.
const cited = JSON.stringify([["whatsapp", values.whatsapp]]);
const evidence =
  "Demo shelter run by the Pawster maintainer, seeded by scripts/seed-demo-shelter.mjs (ADR 0021). " +
  "Not a real shelter and no method was used: its animals are labelled as examples and never mailed.";

process.stdout.write(`-- The demo shelter (ADR 0021). Generated ${new Date(now).toISOString()}.
INSERT OR IGNORE INTO shelters (id, slug, display_name, account_email, base_region, country_code, demo, created_at)
  VALUES (${q(SHELTER_ID)}, ${q(SLUG)}, ${q(DISPLAY_NAME)}, ${q(values.email)}, ${q(values.region)}, 'VE', 1, ${now});
INSERT OR IGNORE INTO shelter_contact_points (id, shelter_id, kind, value, position, created_at)
  SELECT ${q(`${SHELTER_ID}-contact-0`)}, ${q(SHELTER_ID)}, 'whatsapp', ${q(values.whatsapp)}, 0, ${now}
  WHERE EXISTS (SELECT 1 FROM shelters WHERE id = ${q(SHELTER_ID)});
INSERT INTO verifications (shelter_id, outcome, methods, evidence, decided_at, decided_by, cited_display_name, cited_contact_points)
  SELECT ${q(SHELTER_ID)}, 'Verified', '', ${q(evidence)}, ${now}, ${q(values["decided-by"] ?? values.email)}, ${q(DISPLAY_NAME)}, ${q(cited)}
  WHERE EXISTS (SELECT 1 FROM shelters WHERE id = ${q(SHELTER_ID)})
    AND NOT EXISTS (SELECT 1 FROM verifications WHERE shelter_id = ${q(SHELTER_ID)});
SELECT id, slug, account_email, demo FROM shelters WHERE id = ${q(SHELTER_ID)};
`);
