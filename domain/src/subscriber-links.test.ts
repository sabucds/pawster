import { describe, expect, it } from "vitest";
import {
  MANAGE_PATH,
  UNSUBSCRIBE_PATH,
  manageToken,
  manageUrl,
  unsubscribeToken,
  unsubscribeUrl,
  verifyManageToken,
  verifyUnsubscribeToken,
} from "./subscriber-links.ts";

/**
 * The signed links are the subscriber's whole credential, so what is worth testing is not
 * that signing works but that **forging fails** — and, for the manage link, that a rotation
 * actually invalidates what was handed out before it.
 */

const SECRETS = { SUBSCRIBER_LINK_SECRET: "a-test-secret" };
const OTHER = { SUBSCRIBER_LINK_SECRET: "a-different-secret" };
const CONFIG = { ...SECRETS, SITE_ORIGIN: "https://pawster.test" };
const SUBSCRIBER = "3f2a1c44-0000-4000-8000-000000000001";

describe("the unsubscribe token", () => {
  it("round-trips to the subscriber it was built for", async () => {
    const token = await unsubscribeToken(SECRETS, SUBSCRIBER);
    expect(await verifyUnsubscribeToken(SECRETS, token)).toBe(SUBSCRIBER);
  });

  it("is stable, because the header is already in every digest ever delivered", async () => {
    expect(await unsubscribeToken(SECRETS, SUBSCRIBER)).toBe(
      await unsubscribeToken(SECRETS, SUBSCRIBER),
    );
  });

  it("refuses a token signed with another secret", async () => {
    const forged = await unsubscribeToken(OTHER, SUBSCRIBER);
    expect(await verifyUnsubscribeToken(SECRETS, forged)).toBeNull();
  });

  it("refuses a token whose subscriber id was swapped for someone else's", async () => {
    const token = await unsubscribeToken(SECRETS, SUBSCRIBER);
    const tampered = `somebody-else.${token.slice(token.lastIndexOf(".") + 1)}`;
    expect(await verifyUnsubscribeToken(SECRETS, tampered)).toBeNull();
  });

  it("refuses a token with no signature at all", async () => {
    expect(await verifyUnsubscribeToken(SECRETS, SUBSCRIBER)).toBeNull();
    expect(await verifyUnsubscribeToken(SECRETS, "")).toBeNull();
    expect(await verifyUnsubscribeToken(SECRETS, ".abc")).toBeNull();
  });
});

describe("the manage token", () => {
  it("round-trips to the subscriber and the version it was built for", async () => {
    const token = await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 0 });
    expect(await verifyManageToken(SECRETS, token)).toEqual({
      subscriberId: SUBSCRIBER,
      version: 0,
    });
  });

  it("keeps the version, so the caller can compare it against the row", async () => {
    const token = await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 7 });
    expect(await verifyManageToken(SECRETS, token)).toEqual({
      subscriberId: SUBSCRIBER,
      version: 7,
    });
  });

  /**
   * The rotation itself. Two versions of one subscriber's link are different tokens, which is
   * what lets the route refuse the older one by reading a single integer — ADR 0010's
   * "the manage token is rotated on unsubscribe".
   */
  it("differs between versions, which is what makes rotation real", async () => {
    const before = await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 0 });
    const after = await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 1 });
    expect(before).not.toBe(after);
  });

  /**
   * The version is inside the MAC as well as beside it. Without that, a holder of an old link
   * could edit the visible number and walk it forward to whatever the row now says.
   */
  it("refuses a token whose visible version was edited", async () => {
    const token = await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 0 });
    const mac = token.slice(token.lastIndexOf(".") + 1);
    expect(await verifyManageToken(SECRETS, `${SUBSCRIBER}.1.${mac}`)).toBeNull();
  });

  it("refuses a token signed with another secret", async () => {
    const forged = await manageToken(OTHER, { subscriberId: SUBSCRIBER, version: 0 });
    expect(await verifyManageToken(SECRETS, forged)).toBeNull();
  });

  it("refuses a version that is not a canonical decimal integer", async () => {
    for (const version of ["0x0", " 0", "00", "-1", "1e0", ""]) {
      const mac = (
        await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 0 })
      ).split(".")[2]!;
      expect(
        await verifyManageToken(SECRETS, `${SUBSCRIBER}.${version}.${mac}`),
        `version ${JSON.stringify(version)} should not parse`,
      ).toBeNull();
    }
  });

  it("refuses a malformed token", async () => {
    expect(await verifyManageToken(SECRETS, SUBSCRIBER)).toBeNull();
    expect(await verifyManageToken(SECRETS, `${SUBSCRIBER}.0`)).toBeNull();
    expect(await verifyManageToken(SECRETS, "")).toBeNull();
  });
});

/**
 * An unsubscribe token and a manage token for one subscriber are built from overlapping
 * material under one secret, and the labels in `keyed-hash.ts` are the only thing keeping
 * them apart. This is the test that would fail if somebody dropped them.
 */
describe("the two link kinds are not interchangeable", () => {
  it("does not accept an unsubscribe token as a manage token", async () => {
    const token = await unsubscribeToken(SECRETS, SUBSCRIBER);
    expect(await verifyManageToken(SECRETS, token)).toBeNull();
  });

  it("does not accept a manage token as an unsubscribe token", async () => {
    const token = await manageToken(SECRETS, { subscriberId: SUBSCRIBER, version: 0 });
    expect(await verifyUnsubscribeToken(SECRETS, token)).toBeNull();
  });
});

describe("the URLs", () => {
  it("put the token on the route that serves it", async () => {
    const url = await unsubscribeUrl(CONFIG, SUBSCRIBER);
    expect(url.startsWith(`https://pawster.test${UNSUBSCRIBE_PATH}/`)).toBe(true);
    expect(
      await verifyUnsubscribeToken(SECRETS, url.slice(url.lastIndexOf("/") + 1)),
    ).toBe(SUBSCRIBER);
  });

  it("builds a manage URL whose token carries the version", async () => {
    const url = await manageUrl(CONFIG, { subscriberId: SUBSCRIBER, version: 2 });
    expect(url.startsWith(`https://pawster.test${MANAGE_PATH}/`)).toBe(true);
    expect(await verifyManageToken(SECRETS, url.slice(url.lastIndexOf("/") + 1))).toEqual({
      subscriberId: SUBSCRIBER,
      version: 2,
    });
  });

  it("tolerates a trailing slash on the configured origin", async () => {
    const url = await unsubscribeUrl({ ...CONFIG, SITE_ORIGIN: "https://pawster.test/" }, SUBSCRIBER);
    expect(url).toContain(`https://pawster.test${UNSUBSCRIBE_PATH}/`);
    expect(url).not.toContain("test//");
  });
});
