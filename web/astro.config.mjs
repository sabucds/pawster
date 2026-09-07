import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";

/**
 * Prerender first. `output: "static"` is the posture, not a setting we might revisit: the
 * governing rule of the platform is that the Worker runs as rarely as possible, because a
 * file served from Static Assets costs no Worker invocation, no CPU, and does not count
 * against the 100,000 requests/day cap (ADR 0007). A route opts *out* with
 * `export const prerender = false`, and every such route is a decision.
 */
export default defineConfig({
  output: "static",
  /**
   * Astro's session API, not Pawster's Session. Left on, the adapter binds a `SESSION` KV
   * namespace that nothing provisions and nothing reads. A shelter's session is its own
   * concept, held in D1 and begun by typing back an emailed one-time code (ADR 0013).
   */
  session: false,
  adapter: cloudflare({
    platformProxy: { enabled: true },
    /**
     * The adapter defaults to `cloudflare-binding`, which wires `env.IMAGES`. ADR 0012
     * rules that binding out on measurement: its encode runs in our isolate at 22–56 ms of
     * CPU against a 10 ms ceiling, where the `cf.image` fetch form costs 0–2 ms. Pawster
     * generates its derivatives once at upload through `web/src/lib/images.ts`, so Astro
     * needs no image service at all.
     */
    imageService: "passthrough",
  }),
  i18n: {
    // Unprefixed es-VE at the root, prefixed English. Astro's built-in i18n is one of the
    // reasons it was chosen: this is configuration rather than middleware we own and test.
    defaultLocale: "es",
    locales: ["es", "en"],
    routing: { prefixDefaultLocale: false },
  },
});
