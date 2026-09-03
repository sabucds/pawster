import { describe, expect, it } from "vitest";
import { outbound } from "../../test/outbound.ts";

/**
 * The dispatcher's own contract, exercised where a Worker isolate is available — the
 * interceptor replaces `globalThis.fetch` inside the isolate the Worker runs in, so this
 * is the environment it has to hold up in.
 */
describe("the outbound interceptor", () => {
  it("refuses an unregistered host loudly instead of letting it escape", async () => {
    await expect(fetch("https://api.stripe.com/v1/charges")).rejects.toThrow(
      /unregistered host/,
    );

    // Recorded as well as thrown, so a handler that catches its own errors cannot
    // swallow the escape and leave the suite green.
    expect(() => outbound.assertNoViolations()).toThrow(/api\.stripe\.com/);
    outbound.violations.length = 0;
  });

  it("recognises a cf.image transform by its options rather than its host", async () => {
    // The source is our own token-gated original route, so the host alone cannot tell a
    // transform from any other same-origin fetch (ADR 0012).
    await fetch("https://pawster-web.workers.dev/originals/abc?token=t", {
      cf: { image: { width: 1280, format: "webp", fit: "scale-down" } },
    } as RequestInit);

    const transforms = outbound.callsTo("cf.image");
    expect(transforms).toHaveLength(1);
    expect(transforms[0]!.imageTransform).toMatchObject({ width: 1280 });
  });

  it("puts all three vendors in one ordered call log", async () => {
    await fetch("https://api.resend.com/emails", { method: "POST", body: "{}" });
    await fetch("https://hc-ping.com/abc");
    await fetch("https://example.invalid/x", {
      cf: { image: { width: 144 } },
    } as RequestInit);

    expect(outbound.calls.map((call) => call.vendor)).toEqual([
      "resend",
      "healthchecks",
      "cf.image",
    ]);
  });

  it("records the headers and body a vendor was actually sent", async () => {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "idempotency-key": "digest/2026-09-02/s-1" },
      body: JSON.stringify({ to: ["a@example.org"] }),
    });

    const [call] = outbound.callsTo("resend");
    expect(call!.method).toBe("POST");
    expect(call!.headers["idempotency-key"]).toBe("digest/2026-09-02/s-1");
    expect(JSON.parse(call!.body!).to).toEqual(["a@example.org"]);
  });

  it("lets a test override a vendor's reply without replacing the dispatcher", async () => {
    outbound.on("resend", () => new Response("boom", { status: 500 }));

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(outbound.callsTo("resend")).toHaveLength(1);
  });
});
