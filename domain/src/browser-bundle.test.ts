import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * `domain/` is importable from a browser bundle, asserted by bundling it for one. Why the
 * browser is the consumer that matters here is in
 * [`docs/testing-seams.md`](../../docs/testing-seams.md).
 *
 * Paths are relative to the working directory, which is this package's root under both
 * `npm test` and a bare `vitest run` here. A wrong one is an unresolvable entry point and a
 * failing test rather than a check that quietly stops checking.
 */

/** The shared half: `platform: "browser"` is the assertion, the rest is plumbing. */
const BROWSER = {
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
} as const;

describe("domain/ bundles for the browser", () => {
  it("builds from its entry point with no errors and no warnings", async () => {
    const result = await build({ ...BROWSER, entryPoints: ["src/index.ts"] });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.outputFiles?.[0]?.text.length).toBeGreaterThan(0);
  });

  it("would fail on a Node builtin, which is what makes the check above real", async () => {
    // The negative control. Without it the assertion above could be passing for a bundler
    // that silently shims or externalises Node builtins, and would prove nothing at all.
    await expect(
      build({
        ...BROWSER,
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
