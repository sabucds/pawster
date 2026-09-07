import { defineConfig } from "vitest/config";

/**
 * `domain/` is the one package with no Workers runtime: it is pure, so its tests run on
 * plain Node and need no isolate, no bindings and no migrations.
 *
 * It still installs the outbound interceptor. `domain/` performing I/O would be a
 * violation of its whole reason for existing, and `scripts/check-source-rules.mjs` only
 * catches the shapes it can see in the source — a `fetch` reached indirectly would slip
 * past it and be caught here instead.
 */
export default defineConfig({
  test: {
    setupFiles: ["../test/setup.ts"],
  },
});
