import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * `domain/` is importable from a browser bundle, asserted by bundling it for one.
 *
 * The browser is the third consumer and the one that earns this package its seam: ADR 0007
 * filters the listing in the browser over a static index, and no Worker test exercises that
 * island. Purity is checked structurally by `scripts/check-source-rules.mjs` — no `node:`
 * builtin, no `@pawster/db`, no bare package, no `fetch` — but a structural check reads only
 * the shapes it can see in the source, and the question an island actually asks is whether a
 * bundler can produce browser JavaScript from this entry point at all.
 *
 * The negative control is why the positive one means anything: with `platform: "browser"`
 * esbuild refuses to resolve a Node builtin rather than shimming or externalising it.
 *
 * Paths are relative to the working directory, which is this package's root under both
 * `npm test` and a bare `vitest run` here. A wrong one is an unresolvable entry point and a
 * failing test rather than a check that quietly stops checking.
 */

const bundleForBrowser = (options: Parameters<typeof build>[0]) =>
  build({
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
    ...options,
  });

describe("domain/ bundles for the browser", () => {
  it("builds from its entry point with no errors and no warnings", async () => {
    const result = await bundleForBrowser({ entryPoints: ["src/index.ts"] });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.outputFiles?.[0]?.text.length).toBeGreaterThan(0);
  });

  it("would fail on a Node builtin, which is what makes the check above real", async () => {
    await expect(
      bundleForBrowser({
        stdin: {
          contents:
            'import { readFileSync } from "node:fs";\nexport { readFileSync };\n',
          loader: "ts",
          resolveDir: "src",
        },
      }),
    ).rejects.toThrow(/Could not resolve "node:fs"/);
  });
});
