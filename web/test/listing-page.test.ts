import { AGE_BANDS, GOOD_WITH_AXES, SEXES, SIZES, SPECIES } from "@pawster/domain";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CARD_PHOTO_HEIGHT,
  CARD_PHOTO_WIDTH,
} from "../src/lib/listing/card.ts";
import { PROVISIONED_MEDIA_BASE_URL } from "../src/lib/listing/media.ts";

/**
 * The listing page as it is actually served: read out of the Static Assets store, which is
 * the store the asset router answers `/` from without invoking Worker code.
 *
 * What is asserted here is only what belongs to the *shell* — the axes that exist before any
 * script runs, and the three stylesheet rules #17 argued for. The cards, the filtering and
 * the ordering are asserted against the modules that own them, where they can be asserted as
 * decisions rather than as substrings.
 */

let html: string;

beforeAll(async () => {
  const asset = await env.ASSETS.fetch("https://pawster.test/");
  expect(asset.status).toBe(200);
  html = await asset.text();
});

describe("what the page costs", () => {
  /**
   * The same assertion `routing.test.ts` makes and for the same reason, kept here too because
   * this suite is the one a later ticket will edit while changing the listing: a prerendered
   * page is written to `dist/client/` at build time, so the asset store holds it and no Worker
   * invocation is billed. Adding `export const prerender = false` makes this 404.
   */
  it("is in the asset store, which is what makes it free", async () => {
    const asset = await env.ASSETS.fetch("https://pawster.test/");

    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('data-testid="listing"');
  });

  /**
   * Nothing about a particular animal is baked in. If a name or a photo key were in the HTML,
   * a publish would need a rebuild to become visible — which is the thing ADR 0007 rejected
   * when it chose "seconds, not a rebuild".
   */
  it("names no animal, so a publish needs no rebuild", () => {
    expect(html).not.toContain("d/");
    expect(html).not.toContain('data-testid="card"');
    expect(html).toContain('data-testid="grid"');
  });

  it("hands the island the bucket's public base, baked in at build time", () => {
    expect(html).toContain(`data-media-base="${PROVISIONED_MEDIA_BASE_URL}"`);
  });
});

describe("the filter panel before any script runs", () => {
  /**
   * Five of the six axes are closed vocabularies known at build time, so they are real HTML
   * in the served file. The sixth — regions — has no reference data in the platform yet, so
   * the island fills it from the index; its container is here, empty.
   */
  it("carries every value of all five closed axes", () => {
    for (const species of SPECIES) {
      expect(html).toContain(`name="species" value="${species}"`);
    }
    for (const size of SIZES) {
      expect(html).toContain(`name="sizes" value="${size}"`);
    }
    for (const sex of SEXES) {
      expect(html).toContain(`name="sexes" value="${sex}"`);
    }
    for (const band of AGE_BANDS) {
      expect(html).toContain(`name="ageBands" value="${band}"`);
    }
    for (const axis of GOOD_WITH_AXES) {
      expect(html).toContain(`name="goodWith" value="${axis}"`);
    }
  });

  it("leaves the region axis to the island, with a container to fill", () => {
    expect(html).toContain('data-testid="regions"');
    expect(html).not.toContain('name="regions"');
  });

  /**
   * Checkboxes and not radios, on every axis. A radio group would make "Carabobo or Aragua"
   * unsayable, which ADR 0005 requires and which is the axis this matters most on — but the
   * same is true of two species or two life stages.
   */
  it("uses checkboxes throughout, so every axis takes several values", () => {
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('type="checkbox"');
  });

  /** The rule an adopter needs in order to read the results correctly. */
  it("says that filtering on convivencia excludes only a known no", () => {
    expect(html).toContain("solo saca a los animales que sabemos que no convive");
  });

  it("says that several regions can be picked at once", () => {
    expect(html).toContain("varios estados a la vez");
  });
});

describe("the stylesheet rules the card's uniformity rests on", () => {
  /**
   * The bug #17 caught, as an assertion. `max-width: 100%` without `height: auto` makes an
   * `<img>` carrying `width`/`height` attributes ignore its box's aspect ratio, and every card
   * renders about 40% too tall. Both halves have to be present: the attributes are what
   * reserves the box before the bytes arrive, and this is what stops them distorting it.
   */
  it("gives the card photo height:auto beside its max-width", () => {
    const css = html.replace(/\s+/g, "");

    expect(css).toContain("height:auto");
    expect(css).toContain("max-width:100%");
    expect(css).toContain(`aspect-ratio:${CARD_PHOTO_WIDTH}/${CARD_PHOTO_HEIGHT}`);
  });

  /**
   * Three lines, which is the worst case `renderCard` can emit — two known `No`s plus a merged
   * positive, or a `No` plus a positive plus the unknown line. #17 specifies "two", and that
   * number is wrong for its own three-weights rule: only the positives merge and only the
   * unknowns collapse, so each known `No` keeps a line of its own.
   */
  it("reserves three lines for the convivencia slot, whatever is in it", () => {
    const css = html.replace(/\s+/g, "");

    expect(css).toMatch(/\.card-good-with\{[^}]*height:3\.05rem/);
    expect(css).toMatch(/\.card-good-with\{[^}]*line-height:1\.3/);
    expect(css).toMatch(/\.card-good-with\{[^}]*overflow:hidden/);
    /** One line per item, or a wrapped phrase would push the third out of the slot. */
    expect(css).toMatch(/\.card-good-withli\{[^}]*white-space:nowrap/);
  });

  /**
   * **No fixed card height**, and its absence is the fix. The photo's height is a proportion
   * of the card's width, so it grows with the viewport while a `rem` height does not — at the
   * 46rem wrap the photo alone was taller than the card, and the text below it was cut off.
   * Uniformity comes from equal widths plus a per-block reservation instead.
   */
  it("reserves each text block rather than fixing the card's total height", () => {
    const css = html.replace(/\s+/g, "");

    expect(css).not.toMatch(/\.card\{[^}]*height:/);
    for (const block of ["card-name", "card-meta", "card-provenance", "card-good-with"]) {
      expect(css).toMatch(new RegExp(`\\.${block}\\{[^}]*height:`));
      expect(css).toMatch(new RegExp(`\\.${block}\\{[^}]*overflow:hidden`));
    }
  });

  /**
   * Two columns at every width. A three-up rule was briefly here and is what made the clipping
   * above reachable: narrower cards mean a shorter photo and the same text underneath.
   */
  it("stays two-up at every width", () => {
    const css = html.replace(/\s+/g, "");

    expect(css).toContain("grid-template-columns:repeat(2,1fr)");
    expect(css).not.toContain("repeat(3,1fr)");
  });

  it("colours the aged provenance line differently, and nothing else about the card", () => {
    const css = html.replace(/\s+/g, "");

    expect(css).toMatch(/\.card-provenance\.is-aged\{color:/);
  });
});

describe("the island", () => {
  /**
   * A module script, which browsers defer by default — so the prerendered page paints its
   * chrome before any of this is fetched or run. Astro ships it only because this page asked
   * for one; islands architecture is what keeps every other page's JavaScript at zero, which
   * on a metered Venezuelan connection is the framework holding the constraint rather than us
   * remembering to.
   */
  it("is deferred, and is the only script on the page", () => {
    const scripts = html.match(/<script[^>]*>/g) ?? [];

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('type="module"');
  });

  it("is loaded from a file rather than inlined, so it is cached across loads", () => {
    expect(html).toMatch(/<script type="module" src="\/_astro\/[^"]+\.js"/);
  });
});
