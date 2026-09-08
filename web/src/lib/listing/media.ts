/**
 * Where the browser reads the filter index and the photographs from: `pawster-media`'s public
 * base URL, **baked into the page at build time**.
 *
 * A build-time value and not a Worker `var`, and the distinction is the whole of ADR 0007: the
 * listing is a static asset served without invoking Worker code, so there is no request
 * context in which a binding could be read. It is therefore an Astro env var, resolved when
 * the page is rendered to disk.
 *
 * ## Why `PUBLIC_`, and why only this one
 *
 * Vite exposes an env var to client-side code only when its name begins with `PUBLIC_`, and
 * that prefix is doing real work here rather than satisfying a convention: this value ends up
 * in a static file that anybody can read, so it must be a value that is *already* public. It
 * is — `docs/provisioning-record.md` records the bucket's `r2.dev` hostname, and every
 * derivative URL on the site contains it.
 *
 * The env directory stays Astro's default (`web/`), which means the repository root `.env`
 * that `scripts/provision.sh` writes is **not** loaded here. That is deliberate: the root file
 * holds `CLOUDFLARE_API_TOKEN` and `RESEND_API_KEY`, and pointing a build's env loader at a
 * file full of credentials to pick up one hostname is a large blast radius for a small
 * convenience.
 *
 * ## The fallback is the recorded host, not a placeholder
 *
 * With no variable set, this resolves to the hostname in the provisioning record — the bucket
 * this repository actually deploys against. A placeholder would make an unconfigured build
 * produce a listing whose photographs all 404, which looks like a broken index rather than a
 * missing setting; ADR 0018 flags that exact failure mode for the bucket's CORS policy and it
 * is the same trap here. A wrong-but-real host, if the account ever changes, fails the same
 * way and is fixed by setting the variable.
 *
 * ADR 0014 is why this is a plain hostname and not a custom domain: there will not be one, and
 * moving to that ADR's cached Worker later changes this value and nothing else.
 */

/**
 * `pawster-media`'s public hostname as provisioned, from `docs/provisioning-record.md`.
 *
 * Uncached and rate-limited above "hundreds of requests/second" (ADR 0014), which is what
 * makes the pointer's hundred bytes — rather than the 33.4 KB index — the request that scales
 * with traffic worth caring about.
 */
export const PROVISIONED_MEDIA_BASE_URL =
  "https://pub-ca6f4461598148fa980041a7fd05262e.r2.dev";

/**
 * Trailing slashes are trimmed so that callers can join with `/` unconditionally. A base URL
 * pasted with one is the likelier mistake than one pasted without, and `//` in a key is a
 * different R2 object rather than a tidier URL.
 */
function withoutTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

/** The base every card's photo URL and both index fetches are built on. */
export const MEDIA_BASE_URL = withoutTrailingSlash(
  import.meta.env.PUBLIC_MEDIA_BASE_URL ?? PROVISIONED_MEDIA_BASE_URL,
);
