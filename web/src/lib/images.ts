import { DERIVATIVES, type DerivativeName } from "@pawster/domain";

/**
 * The one place Pawster asks Cloudflare to transform an image, and the third destination
 * the outbound interceptor covers.
 *
 * It uses the `cf.image` fetch form. The `env.IMAGES` binding is ruled out and must not
 * come back: its encode runs in our isolate and cost 22–56 ms of CPU at the median against
 * a 10 ms ceiling, with single invocations at 78 ms, while `cf.image` cost 0–2 ms on every
 * sample (issue #34, ADR 0012). The distributions do not overlap.
 *
 * The source is a Worker route that checks a capability token and only then serves the
 * original's bytes — the originals bucket is never public, because a retained original
 * still carries the EXIF a derivative strips. Cloudflare's image pipeline resolves the URL
 * outside the isolate, which is both why a token-gated route works and why `cf.image` is
 * exempt from the rule that a Worker cannot reach its own assets over plain `fetch`.
 */
export async function fetchDerivative(
  originalUrl: string,
  derivative: DerivativeName,
): Promise<Response> {
  const spec = DERIVATIVES[derivative];

  return fetch(originalUrl, {
    cf: {
      image: {
        width: spec.width,
        ...(spec.height === undefined ? {} : { height: spec.height }),
        fit: spec.fit,
        format: spec.format,
        ...(spec.gravity === undefined ? {} : { gravity: spec.gravity }),
      },
    },
  } as RequestInit);
}
