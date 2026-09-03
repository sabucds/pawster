#!/usr/bin/env node
/**
 * #34's third question: are R2's analytics readable on the Free plan?
 *
 * ADR 0012 used the animal count as a proxy for stored bytes, and #36 replaced
 * that with a measured two-bucket total. Neither is the same as asking Cloudflare
 * what it thinks we are storing, which is the only number that ever appears on a
 * bill. This checks whether that number is legible to us at $0 — it is a reality
 * check on the cap, not load-bearing for it.
 *
 * Two routes, because "absence of a restriction" is not a yes and they can differ:
 *   1. GraphQL Analytics API, dataset `r2StorageAdaptiveGroups`
 *   2. REST  GET /accounts/{id}/r2/metrics
 *
 * Needs an API token (OAuth from `wrangler login` is not accepted here), with
 * Account Analytics: Read. Create at
 * https://dash.cloudflare.com/profile/api-tokens
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/probe-r2-analytics.mjs
 */

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token || !account) {
  console.error(
    "set CLOUDFLARE_API_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID",
  );
  process.exit(1);
}

const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const until = new Date().toISOString();

const query = `
  query R2Storage($account: String!, $since: Time!, $until: Time!) {
    viewer {
      accounts(filter: { accountTag: $account }) {
        r2StorageAdaptiveGroups(
          limit: 10
          filter: { datetime_geq: $since, datetime_leq: $until }
        ) {
          max { objectCount payloadSize metadataSize }
          dimensions { bucketName }
        }
      }
    }
  }`;

async function graphql() {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { account, since, until },
    }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function rest() {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/metrics`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

const [g, r] = await Promise.all([graphql(), rest()]);

// A GraphQL 200 carrying an `errors` array is a refusal wearing a success code,
// so readability is judged on the payload, never on the status line.
const gReadable =
  g.status === 200 &&
  !g.body?.errors?.length &&
  Array.isArray(g.body?.data?.viewer?.accounts);
const rReadable = r.status === 200 && r.body?.success === true;

console.log(
  JSON.stringify(
    {
      graphql: { readable: gReadable, status: g.status, body: g.body },
      rest: { readable: rReadable, status: r.status, body: r.body },
      verdict: {
        r2StorageAdaptiveGroups: gReadable ? "readable on this plan" : "not readable",
        "r2/metrics": rReadable ? "readable on this plan" : "not readable",
      },
    },
    null,
    2,
  ),
);
