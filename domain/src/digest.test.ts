import { describe, expect, it } from "vitest";
import { digestIdempotencyKey, DIGEST_DAILY_BUDGET } from "./digest.ts";

describe("digest arithmetic", () => {
  it("keys a send per recipient per period, so a retry is a no-op", () => {
    expect(digestIdempotencyKey("2026-09-02", "sub-1")).toBe(
      "digest/2026-09-02/sub-1",
    );
    expect(digestIdempotencyKey("2026-09-02", "sub-1")).toBe(
      digestIdempotencyKey("2026-09-02", "sub-1"),
    );
    expect(digestIdempotencyKey("2026-09-03", "sub-1")).not.toBe(
      digestIdempotencyKey("2026-09-02", "sub-1"),
    );
  });

  it("reserves 30 of the day's 100 emails for mail a shelter cannot do without", () => {
    expect(DIGEST_DAILY_BUDGET).toBe(70);
  });
});
