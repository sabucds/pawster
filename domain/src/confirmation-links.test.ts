import { describe, expect, it } from "vitest";
import {
  CONFIRM_PATH,
  confirmationUrl,
  verifyConfirmationToken,
} from "./confirmation-links.ts";

/**
 * The nudge link is a Capability (ADR 0008): it must stop working when a newer nudge
 * supersedes it and when the account email changes, and it must not be forgeable.
 */

const CONFIG = { SUBSCRIBER_LINK_SECRET: "a-test-secret", SITE_ORIGIN: "https://pawster.test/" };
const SHELTER = { id: "shelter-1", accountEmail: "hola@refugio.example", nudgeVersion: 3 };

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

async function issued(shelter = SHELTER): Promise<string> {
  return tokenOf(
    await confirmationUrl(CONFIG, {
      shelterId: shelter.id,
      version: shelter.nudgeVersion,
      accountEmail: shelter.accountEmail,
    }),
  );
}

const lookup =
  (shelter: typeof SHELTER | null) =>
  async (id: string) =>
    shelter && shelter.id === id ? shelter : null;

describe("the confirmation link", () => {
  it("lives under the confirm path on the configured origin", async () => {
    const url = await confirmationUrl(CONFIG, {
      shelterId: "shelter-1",
      version: 3,
      accountEmail: SHELTER.accountEmail,
    });
    expect(url.startsWith(`https://pawster.test${CONFIRM_PATH}/`)).toBe(true);
  });

  it("names the shelter while it is the current nudge for the current email", async () => {
    expect(await verifyConfirmationToken(CONFIG, await issued(), lookup(SHELTER))).toBe(
      "shelter-1",
    );
  });

  it("stops working once a newer nudge supersedes it", async () => {
    const token = await issued();
    const later = { ...SHELTER, nudgeVersion: 4 };
    expect(await verifyConfirmationToken(CONFIG, token, lookup(later))).toBeNull();
  });

  it("stops working when the account email changes", async () => {
    const token = await issued();
    const moved = { ...SHELTER, accountEmail: "nuevo@refugio.example" };
    expect(await verifyConfirmationToken(CONFIG, token, lookup(moved))).toBeNull();
  });

  it("refuses a token signed with another secret", async () => {
    const forged = tokenOf(
      await confirmationUrl(
        { ...CONFIG, SUBSCRIBER_LINK_SECRET: "other" },
        { shelterId: "shelter-1", version: 3, accountEmail: SHELTER.accountEmail },
      ),
    );
    expect(await verifyConfirmationToken(CONFIG, forged, lookup(SHELTER))).toBeNull();
  });

  it("refuses an unknown shelter and malformed tokens", async () => {
    expect(await verifyConfirmationToken(CONFIG, await issued(), lookup(null))).toBeNull();
    for (const bad of ["", "shelter-1", "shelter-1.3", ".3.x", "shelter-1.03.x", "shelter-1.x.y"]) {
      expect(await verifyConfirmationToken(CONFIG, bad, lookup(SHELTER))).toBeNull();
    }
  });
});
