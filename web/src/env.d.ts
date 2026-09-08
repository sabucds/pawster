/**
 * The bindings shelter access adds, declared as an augmentation rather than added to
 * `worker-configuration.d.ts`.
 *
 * That file is generated — its header says so, and `wrangler types` rewrites it from
 * `dist/server/wrangler.json` — so anything written into it survives exactly until the next
 * build. The two `vars` below *would* be regenerated, since they are in the committed
 * Wrangler config; the three secrets never will be, because a secret is not in that config
 * and must not be (`wrangler secret put`, not a committed `var`). Declaring all five in one
 * place keeps the Env type honest without depending on which half a generator happens to
 * know about.
 */

declare namespace Cloudflare {
  interface Env {
    /**
     * Signs the Session cookie. A secret: it is the whole thing standing between a
     * hand-written cookie and a shelter's publishing area.
     */
    SESSION_SECRET: string;
    /**
     * Keys the One-Time Code hash and the sign-in ledger's IP fingerprints, domain-separated
     * by purpose inside `auth/crypto.ts`.
     *
     * Separate from `SESSION_SECRET` because the two protect different things and rotating
     * one should not sign every shelter out: rotating this invalidates outstanding *codes*,
     * which costs a shelter one more request, while rotating the session key ends every live
     * session on the platform.
     */
    SIGN_IN_SECRET: string;
    /** Shared with `digest/`, which holds the same key under the same name. */
    RESEND_API_KEY: string;
    /**
     * Who sign-in mail comes from. Distinct from `digest@` so that a shelter's mail client
     * and Postmaster Tools can tell a credential from a newsletter — and so that a spam
     * complaint about the digest cannot take the sign-in sender's reputation with it.
     */
    SIGN_IN_FROM_ADDRESS: string;
    /** Where Pawster answers, for the plain-text origin the code email tells a shelter to type. */
    SITE_ORIGIN: string;
  }
}
