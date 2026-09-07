import { afterEach, beforeEach } from "vitest";
import { outbound } from "./outbound.ts";

/**
 * Installed by every Workers test project. The interceptor goes in once and stays in for
 * the whole run: the point is that nothing can leave without being seen, and a suite that
 * installs it per-test has a window in which something can.
 */
outbound.install();

beforeEach(() => {
  outbound.reset();
});

afterEach(() => {
  outbound.assertNoViolations();
});
