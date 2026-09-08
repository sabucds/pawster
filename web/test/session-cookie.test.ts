import { describe, expect, it } from "vitest";
import { digestsEqual, generateOneTimeCode } from "../src/lib/auth/crypto.ts";
import { ONE_TIME_CODE_DIGITS } from "../src/lib/auth/policy.ts";
import {
  clearSessionCookieHeader,
  clearSignInCookieHeader,
  decodeSession,
  encodeSession,
  readCookie,
  sessionCookieHeader,
  signInCookieHeader,
} from "../src/lib/auth/session.ts";

/**
 * The cookie codec and the primitives under it. These run in the Workers isolate like every
 * other test in this package, which means the WebCrypto here is the real one the Worker
 * uses rather than Node's — the point of the seam.
 */

const SECRET = "a-test-secret";
const CLAIMS = {
  shelterId: "shelter-1",
  issuedAt: new Date("2026-09-07T12:00:00Z"),
  epoch: 3,
};

describe("the Session cookie", () => {
  it("round-trips the three claims it carries, and only those three", async () => {
    const cookie = await encodeSession(SECRET, CLAIMS);
    const claims = await decodeSession(SECRET, cookie);

    expect(claims).toEqual(CLAIMS);
  });

  it("survives a shelter id that is not a UUID", async () => {
    // The payload is JSON rather than a delimiter-joined string precisely so that no field's
    // value can be mistaken for a separator. A `.` in the id is the case that would break
    // the naive form, since the signature is split on the last one.
    const odd = { ...CLAIMS, shelterId: "shelter.1.with.dots" };
    expect(await decodeSession(SECRET, await encodeSession(SECRET, odd))).toEqual(odd);
  });

  it("refuses a payload signed with a different secret", async () => {
    const cookie = await encodeSession("some-other-secret", CLAIMS);
    expect(await decodeSession(SECRET, cookie)).toBeNull();
  });

  it("refuses a payload whose claims were edited after signing", async () => {
    /**
     * The attack the signature exists to stop: re-encode a payload naming a different
     * shelter and keep the old signature. Without integrity this is a complete account
     * takeover with no credential at all.
     */
    const cookie = await encodeSession(SECRET, CLAIMS);
    const [, signature] = cookie.split(".");
    const forged = btoa(JSON.stringify({ s: "shelter-2", i: 0, e: 0 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await decodeSession(SECRET, `${forged}.${signature}`)).toBeNull();
  });

  it("refuses a cookie whose epoch has been raised by hand", async () => {
    // A shelter that has been revoked cannot re-authorise itself by writing a higher epoch
    // into its own cookie, because the epoch is inside the signed payload.
    const cookie = await encodeSession(SECRET, CLAIMS);
    const tampered = cookie.replace(/^[^.]+/, (payload) => {
      const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
      const edited = JSON.stringify({ ...JSON.parse(json), e: 99 });
      return btoa(edited).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    });

    expect(await decodeSession(SECRET, tampered)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no separator", "onlyonepart"],
    ["no payload", ".signature"],
    ["not base64", "!!!.???"],
    ["valid base64 that is not JSON", `${btoa("hello")}.sig`],
  ])("returns null rather than throwing on a %s cookie", async (_label, value) => {
    // A malformed cookie has to become a signed-out shelter, never a 500: the shelter can
    // act on the first and can do nothing at all about the second.
    expect(await decodeSession(SECRET, value)).toBeNull();
  });
});

describe("the Set-Cookie attributes", () => {
  it("is HttpOnly, Secure and SameSite=Lax, scoped to the whole site", () => {
    const header = sessionCookieHeader("value");

    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    // `Lax` rather than `Strict`: under `Strict` a shelter arriving from a link in its own
    // confirmation nudge would land signed out, having done nothing wrong. `Lax` still
    // withholds the cookie from cross-site POSTs, which is the half that matters.
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });

  it("expires with the session rather than with the browser tab", () => {
    // 90 days in seconds. A session cookie with no Max-Age would end when the browser did,
    // which on a shared shelter phone is often the same day.
    expect(sessionCookieHeader("value")).toContain(`Max-Age=${90 * 24 * 60 * 60}`);
  });

  it("scopes each cookie to a path that actually covers the code reading it", () => {
    /**
     * The regression test for the one bug in this change that no route test could see.
     *
     * The sign-in cookie was first scoped to `Path=/refugios`, on the reasoning that it
     * belonged to the code form. RFC 6265 §5.1.4 sends a cookie only where its path is a
     * **prefix of the request path**, and `/refugios` is not a prefix of
     * `/api/refugios/sesion` — the only thing that ever reads it. A browser would never have
     * sent it and every sign-in would have collapsed to "ese código no sirvió".
     *
     * `shelter-access.test.ts` passes either way, because it sets the `cookie` header by
     * hand: it exercises the server's parsing and never the browser's scoping rule. So the
     * relationship is asserted here directly, which is the only form of the check available
     * without a real browser — and it is stated as the rule rather than as the string, so
     * moving a route breaks it.
     */
    const pathMatches = (cookiePath: string, requestPath: string) =>
      cookiePath === "/" ||
      requestPath === cookiePath ||
      requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);

    const pathOf = (header: string) =>
      header.split("; ").find((part) => part.startsWith("Path="))!.slice("Path=".length);

    // Every route that reads the sign-in handle.
    const signInPath = pathOf(signInCookieHeader("token", 600_000));
    expect(pathMatches(signInPath, "/api/refugios/sesion")).toBe(true);
    expect(pathMatches(signInPath, "/api/refugios/codigo")).toBe(true);
    // And it stays off the prerendered pages, which have no business carrying a credential.
    expect(pathMatches(signInPath, "/refugios/entrar")).toBe(false);
    expect(pathMatches(signInPath, "/")).toBe(false);

    // Every route that reads the Session.
    const sessionPath = pathOf(sessionCookieHeader("value"));
    for (const route of ["/refugios/panel", "/api/refugios/salir"]) {
      expect(pathMatches(sessionPath, route), `${route} needs the session`).toBe(true);
    }

    // The clearing headers have to match the cookies they replace, path included.
    expect(pathOf(clearSignInCookieHeader())).toBe(signInPath);
    expect(pathOf(clearSessionCookieHeader())).toBe(sessionPath);
  });

  it("clears with every attribute intact except the lifetime", () => {
    /**
     * A browser matches a replacement cookie on name, path and the security attributes; get
     * one wrong and the original is left in place while the response looks like it worked.
     * So the clearing header has to be the same list with `Max-Age=0`, not a shorter one.
     */
    const clear = clearSessionCookieHeader();
    for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(clear).toContain(attribute);
    }
    expect(clear).toContain("Max-Age=0");
  });
});

describe("reading a cookie off a request", () => {
  const withCookie = (header: string) =>
    new Request("https://pawster.test/", { headers: { cookie: header } });

  it("finds a value among several", () => {
    expect(readCookie(withCookie("a=1; pawster_session=xyz; b=2"), "pawster_session")).toBe("xyz");
  });

  it("does not match a name by prefix", () => {
    // `pawster_session_other` must not answer for `pawster_session`, or a cookie an attacker
    // can set on a neighbouring name becomes the session.
    expect(readCookie(withCookie("pawster_session_other=xyz"), "pawster_session")).toBeNull();
  });

  it("takes the first of a duplicated name", () => {
    expect(readCookie(withCookie("pawster_session=first; pawster_session=second"), "pawster_session")).toBe("first");
  });

  it("returns null when there is no cookie header at all", () => {
    expect(readCookie(new Request("https://pawster.test/"), "pawster_session")).toBeNull();
  });
});

describe("code generation", () => {
  it("is always exactly six digits, leading zeroes included", () => {
    /**
     * A thousand draws, because the failure this guards against is intermittent by nature:
     * `String(draw % 1e6)` without the pad produces a five-character code roughly one time
     * in ten, and a single-draw test passes nine times out of ten.
     */
    for (let i = 0; i < 1000; i++) {
      const code = generateOneTimeCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(ONE_TIME_CODE_DIGITS);
    }
  });

  it("does not repeat itself", () => {
    // Not a randomness test — it cannot be — but it does catch a generator that has been
    // reduced to a constant or seeded once at module scope.
    const draws = new Set(Array.from({ length: 200 }, () => generateOneTimeCode()));
    expect(draws.size).toBeGreaterThan(150);
  });
});

describe("digest comparison", () => {
  it("matches identical strings and rejects differences at either end", () => {
    expect(digestsEqual("abcdef", "abcdef")).toBe(true);
    expect(digestsEqual("abcdef", "Xbcdef")).toBe(false);
    expect(digestsEqual("abcdef", "abcdeX")).toBe(false);
    expect(digestsEqual("abcdef", "abcde")).toBe(false);
    expect(digestsEqual("", "")).toBe(true);
  });
});
