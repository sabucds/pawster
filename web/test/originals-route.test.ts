import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ORIGINAL_TOKEN_TTL_MS,
  mintOriginalToken,
  verifyOriginalToken,
} from "../src/lib/photos/capability.ts";

/**
 * The route that lets Cloudflare's image pipeline read one original and lets nothing else
 * read anything.
 *
 * ADR 0012 needs the originals bucket to be **both** private — a retained original carries
 * the EXIF, GPS included, that every derivative discards — and reachable by URL, because
 * `cf.image` resolves its source outside our isolate. This route is where those two meet,
 * and the 403 below is the half that makes the arrangement safe rather than merely
 * convenient. Issue #34 measured it against real Cloudflare: 1 ms of CPU through the gated
 * route, and a bad token refused 403, surfacing as `cf-resized: err=9408`.
 */

const ORIGIN = "https://pawster.test";
const KEY = "o/11111111-2222-3333-4444-555555555555";
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);

function get(key: string, token: string | null): Promise<Response> {
  const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  return SELF.fetch(`${ORIGIN}/api/originales/${key}${query}`);
}

beforeEach(async () => {
  const listed = await env.ORIGINALS.list();
  if (listed.objects.length > 0) {
    await env.ORIGINALS.delete(listed.objects.map((object) => object.key));
  }
  await env.ORIGINALS.put(KEY, BYTES, {
    httpMetadata: { contentType: "image/jpeg" },
  });
});

describe("the token-gated original route", () => {
  it("serves the bytes to a holder of a valid capability", async () => {
    const token = await mintOriginalToken(env, KEY, new Date());
    const response = await get(KEY, token);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("never lets the response be cached", async () => {
    // The exact opposite of a derivative, and for the same reason a derivative is immutable:
    // a derivative's key is its content and is safe forever, while this response's
    // *authorisation* expires in five minutes — and these are the bytes with the GPS in them.
    const token = await mintOriginalToken(env, KEY, new Date());
    const response = await get(KEY, token);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses a bad token with 403", async () => {
    // The measured behaviour ADR 0012 records, and the reason the bucket can stay private.
    expect((await get(KEY, "not-a-token")).status).toBe(403);
  });

  it("refuses a request with no token at all", async () => {
    expect((await get(KEY, null)).status).toBe(403);
  });

  it("refuses a token minted for a different key", async () => {
    // A capability over one object, not a session over the bucket. Otherwise one leaked
    // token would read every original the platform holds.
    const other = "o/99999999-8888-7777-6666-555555555555";
    await env.ORIGINALS.put(other, BYTES);
    expect((await get(KEY, await mintOriginalToken(env, other, new Date()))).status).toBe(
      403,
    );
  });

  it("refuses a token whose expiry has been edited", async () => {
    // The expiry is inside the signed message as well as beside it, which is the difference
    // between an expiry and a suggestion.
    const token = await mintOriginalToken(env, KEY, new Date());
    const signature = token.slice(token.indexOf(".") + 1);
    const forged = `${Date.now() + 10 * 365 * 24 * 60 * 60_000}.${signature}`;
    expect((await get(KEY, forged)).status).toBe(403);
  });

  it("refuses an expired token", async () => {
    const past = new Date(Date.now() - ORIGINAL_TOKEN_TTL_MS - 1000);
    expect((await get(KEY, await mintOriginalToken(env, KEY, past))).status).toBe(403);
  });

  it("answers 403 and not 404 for an object that is not there", async () => {
    // A 404 would turn an unauthorised caller into an oracle for which originals the
    // platform holds — and by extension for which shelters are mid-publish.
    const missing = "o/00000000-0000-0000-0000-000000000000";
    const token = await mintOriginalToken(env, missing, new Date());
    expect((await get(missing, token)).status).toBe(403);
  });

  it("refuses a key outside the originals prefix, however well signed", async () => {
    // Not a traversal defence — R2 keys are opaque strings, not paths. It keeps the route
    // pointed at one prefix, so a second prefix added to this bucket later cannot become
    // readable through a URL written before it existed.
    await env.ORIGINALS.put("secrets/ledger", BYTES);
    const token = await mintOriginalToken(env, "secrets/ledger", new Date());
    expect((await get("secrets/ledger", token)).status).toBe(403);
  });

  it("needs no session, because it is a capability and not one", async () => {
    // ADR 0008's shape. The caller here is Cloudflare's image pipeline, which holds no
    // cookie and never will; what it holds is a signature over one key.
    const token = await mintOriginalToken(env, KEY, new Date());
    const response = await SELF.fetch(
      `${ORIGIN}/api/originales/${KEY}?token=${encodeURIComponent(token)}`,
      { headers: { cookie: "" } },
    );
    expect(response.status).toBe(200);
  });
});

describe("the capability itself", () => {
  it("verifies exactly what it minted, and nothing adjacent", async () => {
    const now = new Date();
    const token = await mintOriginalToken(env, KEY, now);

    expect(await verifyOriginalToken(env, KEY, token, now)).toBe(true);
    expect(await verifyOriginalToken(env, `${KEY}x`, token, now)).toBe(false);
    expect(await verifyOriginalToken(env, KEY, `${token}x`, now)).toBe(false);
    expect(await verifyOriginalToken(env, KEY, null, now)).toBe(false);
    expect(await verifyOriginalToken(env, KEY, "", now)).toBe(false);
    expect(await verifyOriginalToken(env, KEY, ".", now)).toBe(false);
  });

  it("expires on the far side of five minutes and not before", async () => {
    const now = new Date();
    const token = await mintOriginalToken(env, KEY, now);

    const lastMoment = new Date(now.getTime() + ORIGINAL_TOKEN_TTL_MS - 1);
    const justAfter = new Date(now.getTime() + ORIGINAL_TOKEN_TTL_MS);

    expect(await verifyOriginalToken(env, KEY, token, lastMoment)).toBe(true);
    expect(await verifyOriginalToken(env, KEY, token, justAfter)).toBe(false);
  });

  it("does not verify under a different secret", async () => {
    const now = new Date();
    const token = await mintOriginalToken(env, KEY, now);
    // Rotating `ORIGINAL_SECRET` invalidates outstanding capabilities and nothing else — which
    // is the whole argument for it being its own secret rather than a use of the session key.
    expect(
      await verifyOriginalToken({ ORIGINAL_SECRET: "rotated" }, KEY, token, now),
    ).toBe(false);
  });
});
