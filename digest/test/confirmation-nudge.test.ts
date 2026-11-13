import { env } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import {
  animals,
  createDb,
  shelters,
  uploadSessions,
  verifications,
} from "@pawster/db";
import { CONFIRM_PATH, verifyConfirmationToken } from "@pawster/domain";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";

/**
 * The monthly Confirmation Nudge (issue #60): one email per shelter, listing every animal
 * it has left unconfirmed for thirty days, carrying a link that supersedes the last one.
 */

type ScheduledInvocable = {
  scheduled(options: { scheduledTime: Date | number }): Promise<{ outcome: string }>;
};
const runScheduled = (scheduledTime: Date) =>
  (workerExports.default as unknown as ScheduledInvocable).scheduled({ scheduledTime });

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 8, 2, 11, 0, 0));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const db = () => createDb(env.DB);

async function seedShelter(
  id: string,
  options: { outcome?: "Verified" | "Refused" | "Revoked" | null; nudgedAt?: Date } = {},
) {
  await db().insert(shelters).values({
    id,
    slug: id,
    displayName: `Refugio ${id}`,
    accountEmail: `${id}@refugio.example`,
    baseRegion: "Miranda",
    countryCode: "VE",
    nudgedAt: options.nudgedAt ?? null,
    createdAt: daysAgo(400),
  });
  const outcome = options.outcome === undefined ? "Verified" : options.outcome;
  if (outcome) {
    await db().insert(verifications).values({
      shelterId: id,
      outcome,
      methods: "[]",
      evidence: "test",
      decidedAt: daysAgo(300),
      decidedBy: "admin@pawster.test",
      citedDisplayName: `Refugio ${id}`,
      citedContactPoints: "[]",
    });
  }
}

async function seedAnimal(
  id: string,
  shelterId: string,
  lastConfirmedAt: Date,
  availability: "Available" | "Adopted" | "NoLongerAvailable" = "Available",
) {
  await db().insert(uploadSessions).values({ id: `${id}-session`, shelterId, createdAt: daysAgo(400) });
  await db().insert(animals).values({
    id,
    shelterId,
    uploadSessionId: `${id}-session`,
    name: id,
    species: "dog",
    size: "Medium",
    sex: "Female",
    estimatedBirthDate: new Date("2025-01-01"),
    ageEstimateBasis: "ShelterGuess",
    region: "Miranda",
    goodWithChildren: "Yes",
    goodWithDogs: "Yes",
    goodWithCats: "Unknown",
    description: "x",
    sterilisation: "Sterilised",
    availability,
    lastConfirmedAt,
    matchableSince: daysAgo(400),
  });
}

const nudges = () =>
  outbound
    .callsTo("resend")
    .map((call) => JSON.parse(call.body!) as { to: string[]; subject: string; text: string })
    .filter((mail) => mail.to.some((to) => to.endsWith("@refugio.example")));

function tokenIn(text: string): string {
  const prefix = `${env.SITE_ORIGIN}${CONFIRM_PATH}/`;
  const match = text.match(new RegExp(`${prefix}\\S+`));
  expect(match, "the nudge should carry a confirmation link").not.toBeNull();
  return match![0].slice(prefix.length);
}

async function shelterRow(id: string) {
  const [row] = await db().select().from(shelters).where(eq(shelters.id, id));
  return row!;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM animals");
  await env.DB.exec("DELETE FROM upload_sessions");
  await env.DB.exec("DELETE FROM verifications");
  await env.DB.exec("DELETE FROM shelters");
});

describe("the confirmation nudge", () => {
  it("sends one email per shelter listing every animal unconfirmed for thirty days", async () => {
    await seedShelter("s1");
    await seedAnimal("Canela", "s1", daysAgo(31));
    await seedAnimal("Toby", "s1", daysAgo(90));
    await seedAnimal("Fresca", "s1", daysAgo(5));
    await seedAnimal("Adoptada", "s1", daysAgo(60), "Adopted");

    await runScheduled(NOW);

    const mails = nudges();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual(["s1@refugio.example"]);
    expect(mails[0]!.text).toContain("Canela");
    expect(mails[0]!.text).toContain("Toby");
    expect(mails[0]!.text).not.toContain("Fresca");
    expect(mails[0]!.text).not.toContain("Adoptada");

    const row = await shelterRow("s1");
    const token = tokenIn(mails[0]!.text);
    await expect(
      verifyConfirmationToken(env, token, async () => row),
    ).resolves.toBe("s1");
  });

  it("is monthly: no second nudge within thirty days", async () => {
    await seedShelter("s1");
    await seedAnimal("Canela", "s1", daysAgo(31));

    await runScheduled(NOW);
    outbound.reset();
    await runScheduled(new Date(NOW.getTime() + 10 * DAY));

    expect(nudges()).toHaveLength(0);
  });

  it("retires the previous link when it sends the next one", async () => {
    await seedShelter("s1", { nudgedAt: daysAgo(40) });
    await seedAnimal("Canela", "s1", daysAgo(31));

    await runScheduled(NOW);
    const first = tokenIn(nudges()[0]!.text);
    outbound.reset();
    await runScheduled(new Date(NOW.getTime() + 31 * DAY));
    const second = tokenIn(nudges()[0]!.text);

    const row = await shelterRow("s1");
    const load = async () => row;
    await expect(verifyConfirmationToken(env, first, load)).resolves.toBeNull();
    await expect(verifyConfirmationToken(env, second, load)).resolves.toBe("s1");
  });

  it("never nudges a pending, refused or revoked shelter", async () => {
    await seedShelter("pending", { outcome: null });
    await seedShelter("revoked", { outcome: "Revoked" });
    await seedAnimal("A", "pending", daysAgo(60));
    await seedAnimal("B", "revoked", daysAgo(60));

    await runScheduled(NOW);

    expect(nudges()).toHaveLength(0);
  });

  it("keeps the link current when the send fails, so the next run retries", async () => {
    await seedShelter("s1");
    await seedAnimal("Canela", "s1", daysAgo(31));
    outbound.on("resend", () => new Response("rate limited", { status: 429 }));

    await runScheduled(NOW);

    const row = await shelterRow("s1");
    expect(row.nudgedAt).toBeNull();
    expect(row.nudgeVersion).toBe(0);
  });
});
