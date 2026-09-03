import { describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";
import { fetchDerivative } from "../src/lib/images.ts";

/**
 * The third vendor. `cf.image` is the only form Pawster uses; `env.IMAGES` is ruled out on
 * measurement (ADR 0012), which is why there is no test for it and no binding to test.
 */
describe("fetchDerivative", () => {
  const ORIGINAL = "https://pawster-web.workers.dev/originals/abc?token=t";

  it("asks for the digest thumbnail as a saliency-cropped JPEG", async () => {
    await fetchDerivative(ORIGINAL, "digestThumbnail");

    const [call] = outbound.callsTo("cf.image");
    expect(call!.url).toBe(ORIGINAL);
    expect(call!.imageTransform).toEqual({
      width: 144,
      height: 144,
      fit: "cover",
      format: "jpeg",
      // Outlook does not render WebP at all and Gmail transcodes it, so the digest
      // thumbnail is JPEG on purpose.
      gravity: "auto",
    });
  });

  it("asks for the detail image at 1280px WebP with no crop", async () => {
    await fetchDerivative(ORIGINAL, "detailImage");

    const [call] = outbound.callsTo("cf.image");
    expect(call!.imageTransform).toEqual({
      width: 1280,
      fit: "scale-down",
      format: "webp",
    });
    // `gravity` is meaningless without a crop, and sending it anyway would be noise in
    // the one place the transformation budget is spent.
    expect(call!.imageTransform).not.toHaveProperty("gravity");
    expect(call!.imageTransform).not.toHaveProperty("height");
  });

  it("goes through the same dispatcher as Resend and the watchdog", async () => {
    await fetchDerivative(ORIGINAL, "cardThumbnail");
    await fetch("https://hc-ping.com/abc");

    expect(outbound.calls.map((call) => call.vendor)).toEqual([
      "cf.image",
      "healthchecks",
    ]);
  });
});
